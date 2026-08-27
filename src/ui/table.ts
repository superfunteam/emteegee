/**
 * The table renderer.
 *
 * Nodes are keyed by CardId and patched in place rather than rebuilt. That matters
 * more than it sounds: replacing a node restarts its CSS transitions, so a diffing
 * renderer would make a creature that is mid-attack snap back to rest every time any
 * other part of the board changed.
 *
 * This module renders. It never mutates game state and never decides legality — it
 * asks `legalActions` what is possible and paints the answer.
 */

import type {
  Action, CardId, GameState, Keyword, PlayerId, Color,
} from '../engine/types';
import { PHASE_ORDER } from '../engine/types';
import {
  cardsIn, def, inst, isCreature, powerOf, toughnessOf, hasKeyword, availableMana, opponentOf,
} from '../engine/state';
import { legalActions, canCast } from '../engine/actions';
import { el, clear, reflow } from './dom';
import { patchStack } from './stack';
import type { DropTarget } from './gestures';
import {
  bolt, centerOf, createFxLayer, dissolve, fly, ghostBack, ghostCard, impactRing, peck, rectAt,
} from './fx';

/** One glyph per keyword, chosen to read at 9px. */
const KEYWORD_GLYPH: Partial<Record<Keyword, string>> = {
  flying: '↑',
  reach: '↗',
  vigilance: '◇',
  trample: '▶',
  haste: '⚡',
  deathtouch: '☠',
  lifelink: '✚',
  'first strike': '⚔',
  'double strike': '⚔',
  menace: '✖',
  defender: '■',
  ward: '○',
  hexproof: '◎',
  flash: '◆',
};

/** Order matters: the three most tactically relevant keywords win the three slots. */
const GLYPH_PRIORITY: Keyword[] = [
  'flying', 'deathtouch', 'double strike', 'first strike', 'trample',
  'menace', 'lifelink', 'vigilance', 'reach', 'haste', 'defender', 'hexproof', 'ward', 'flash',
];

/**
 * The current phase is spelled out; every other phase is a dot.
 *
 * The old rail read "UN UP DR M1 CB M2 END" — seven abbreviations in a game whose
 * whole voice is "the button says exactly what the tap will do". A beginner cannot
 * expand M1, and a player who can does not need the rail. One word plus six dots keeps
 * what the rail is actually for: the shape of a turn, and where in it you are —
 * especially during the Magician's turn, when the sweeping dot is the visible
 * heartbeat of a turn resolving.
 */
const PHASE_WORD: Partial<Record<string, string>> = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main',
  declareAttackers: 'Combat', main2: 'Second main', end: 'End',
};

/** The phases the rail shows. The rest are real but not worth a slot. */
const RAIL_PHASES = ['untap', 'upkeep', 'draw', 'main1', 'declareAttackers', 'main2', 'end'] as const;

export interface TableCallbacks {
  onTileTap(card: CardId): void;
  /** A player's rail, tapped as a spell target. Burn to the face lives here. */
  onRailTap(player: PlayerId): void;
  onHandTap(card: CardId): void;
  onManaTap(player: PlayerId): void;
  onZoneTap(zone: 'graveyard' | 'exile', player: PlayerId): void;
  onAct(): void;
}

/** What a strike is aimed at: a creature's tile, or a player's whole rail. */
export type StrikeTarget = { kind: 'tile'; id: CardId } | { kind: 'rail'; you: boolean };

/** Where a resolved stack object ended up, as far as the table can show it. */
export type ResolveDest =
  | { kind: 'battlefield'; attachedTo: CardId | null }
  | { kind: 'grave' }
  | { kind: 'away' };

export interface TableView {
  root: HTMLElement;
  /** A brief sweep naming whose turn it now is. */
  banner(text: string): void;
  /** Shake a hand card that was just refused. */
  refuse(card: CardId): void;
  /** The moment of contact, played on the damage beat. */
  clash(card: CardId): void;
  patch(state: GameState, ui: UiState): void;
  tileFor(card: CardId): HTMLElement | undefined;
  floaty(text: string, kind: 'damage' | 'gain', anchor: 'you' | 'opponent'): void;
  ribbon(text: string | null): void;
  /**
   * Record where everything currently is, before a batch of events repaints the
   * table. The repaint jumps straight to the final state; the travel ghosts need to
   * know where things USED to be, and this is the only moment that knowledge exists.
   */
  snapshot(): void;
  /**
   * Keep these tiles on the board past their removal from state, so a creature is
   * still standing when the damage that kills it lands. `perish` releases each one
   * on its DIE beat; `releaseHeld` sweeps up anything a batch left behind.
   */
  holdForDeaths(cards: CardId[]): void;
  releaseHeld(): void;
  /** The DIE beat: the tile leaves the board, toward the graveyard if it is yours. */
  perish(card: CardId, opts: { instant: boolean; toGrave: boolean }): void;
  /**
   * One hit, directed: the source pecks at its target, the target takes the impact.
   * `sourceYours` picks the fallback origin for a source with no body on screen.
   * Returns the ms until contact so the caller can time the numbers to the blow.
   */
  strike(source: CardId, target: StrikeTarget, sourceYours: boolean): number;
  /** A ring flash on a tile — a trigger firing, a counter landing. */
  pulse(card: CardId): void;
  /** A card back travelling from a library counter into a hand. */
  flyDraw(you: boolean, card: CardId): void;
  /** A land travelling from a hand into its owner's mana row. */
  flyPlay(card: CardId, image: string, you: boolean): void;
  /**
   * A card leaving a hand for wherever it now is: the stack when it is waiting
   * there, or — when it resolved in the same batch it was cast, so the stack moment
   * never reaches the screen — its tile, the graveyard, or a fade at mid-table.
   */
  flyFromHand(card: CardId, image: string, you: boolean, dest: 'stack' | 'board' | 'grave' | 'mid'): void;
  /** A resolved stack object travelling from the stack to wherever it ended up. */
  flyResolve(card: CardId, art: string, to: ResolveDest): void;
  /** A countered spell shaking apart where it sat on the stack. */
  fizzle(card: CardId, art: string): void;
}

/** Presentation-only state: what the player has picked up but not yet committed. */
export interface UiState {
  you: PlayerId;
  selected: Set<CardId>;
  targetable: Set<CardId>;
  /**
   * Players a spell may currently point at. Without this the face is unreachable and
   * "deals N damage to any target" is only half a card.
   */
  targetablePlayers: Set<PlayerId>;
  blockingPairs: Map<CardId, CardId>;
  actLabel: string;
  actEnabled: boolean;
  /**
   * Hidden entirely while a prompt owns the screen. The button's whole contract is
   * that it says what the next tap does; a disabled one wearing a noun ("Your opening
   * hand") behind a modal says nothing and only competes with the panel's own buttons.
   */
  actHidden: boolean;
  hint: string | null;
  speech: string | null;
  /**
   * Damage that would get through right now, previewed on the life total while blocks
   * are being assigned.
   *
   * This is the moment a beginner is most lost, and a number that moves as they block
   * teaches what blocking is for far better than a sentence about it does.
   */
  incoming: { player: PlayerId; amount: number } | null;
  /** A dragged card could land on open felt: your board reads as a drop zone. */
  boardDrop: boolean;
  /**
   * The dragged card is a land: the mana row is its drop zone. Lands do not go where
   * creatures go — they become the row of mana — and lighting the row they will end
   * up in teaches the abstraction in one gesture.
   */
  landDrop: boolean;
  /**
   * The one target under the finger right now, or null when nothing is being dragged.
   * Distinct from the set of legal targets: those say where the card MAY go, this says
   * where letting go WILL send it.
   */
  over: DropTarget | null;
}

export function createTable(callbacks: TableCallbacks): TableView {
  const oppRail = el('div.rail');
  const oppMana = el('div.mana');
  const oppBoard = el('div.board.board--opponent');
  const mid = el('div.mid');
  const youBoard = el('div.board.board--you');
  const youMana = el('div.mana.mana--you');
  const youRail = el('div.rail.rail--you');
  const hand = el('div.hand');
  const backs = el('div.hand__backs');

  const stack = el('div.stack', { role: 'status' });
  stack.hidden = true;

  const act = el<HTMLButtonElement>('button.act', { type: 'button' });
  act.addEventListener('click', () => callbacks.onAct());

  const fx = createFxLayer();

  const root = el('div.table', { role: 'application', 'aria-label': 'Magic game table' },
    oppRail, backs, oppMana, oppBoard, mid, youBoard, youMana, youRail, hand, stack, fx, act);

  const tiles = new Map<CardId, HTMLElement>();
  const handCards = new Map<CardId, HTMLElement>();
  let ribbonNode: HTMLElement | null = null;
  let hintNode: HTMLElement | null = null;

  /**
   * Tiles kept on the board past their removal from state, keyed by the DIE events
   * still waiting to play. Without this, a batch that deals lethal damage removes the
   * creature on its very first repaint — before the blow that killed it is shown —
   * and the clash lands on empty felt.
   */
  const held = new Set<CardId>();

  /**
   * Combat stances frozen for the length of a batch. The repaint jumps straight to
   * the final state, where `attacking` is already false — so without this, every
   * creature snaps home, taps and dims BEFORE its blow is shown, and the strikes
   * launch from resting cards that no longer point at anything. Captured from the
   * classes on screen when the batch begins, released when it ends.
   */
  const poses = new Map<CardId, 'attacking' | 'blocking'>();

  /**
   * Hand card nodes removed by the latest repaint, kept for one batch. A flight out
   * of the hand adopts the card's own already-decoded <img>, so the ghost cannot
   * flash blank while a fresh copy of the image decodes.
   */
  const departed = new Map<CardId, HTMLElement>();

  /** A hand card's place in the fan: its unrotated box, and the angle it sat at. */
  interface HandSpot {
    rect: DOMRect;
    rot: number;
  }

  /** Where everything was before the current batch of events repainted the table. */
  interface Snap {
    hand: Map<CardId, HandSpot>;
    tiles: Map<CardId, DOMRect>;
    /** The art thumb of each stack row, which is the part a ghost matches. */
    stackArts: Map<CardId, DOMRect>;
    backs: DOMRect;
    libYou: DOMRect | null;
    libThem: DOMRect | null;
  }
  let snap: Snap | null = null;

  function patch(state: GameState, ui: UiState): void {
    const them = opponentOf(ui.you);
    const actions = legalActions(state);

    patchRail(oppRail, state, them, false, ui, callbacks);
    patchRail(youRail, state, ui.you, true, ui, callbacks);
    patchMana(oppMana, state, them, false, callbacks);
    patchMana(youMana, state, ui.you, true, callbacks);
    patchBoard(oppBoard, state, them, ui, tiles, held, poses, callbacks);
    patchBoard(youBoard, state, ui.you, ui, tiles, held, poses, callbacks);
    youBoard.classList.toggle('board--drop', ui.boardDrop);
    youMana.classList.toggle('mana--drop', ui.landDrop);
    // Sized after both boards exist, so each measures the height it actually got.
    sizeTiles(oppBoard);
    sizeTiles(youBoard);
    patchMid(mid, state, ui.you, callbacks);
    patchStack(stack, state, ui.you, card => callbacks.onTileTap(card));
    patchHand(hand, state, ui, handCards, departed, actions, callbacks);
    patchBacks(backs, state, them);

    act.textContent = ui.actLabel;
    act.disabled = !ui.actEnabled;
    act.hidden = ui.actHidden;
    act.classList.toggle('act--waiting', !ui.actEnabled);

    setRibbon(ui.speech);
    setHint(ui.hint);
  }

  function setRibbon(text: string | null): void {
    if (!text) { ribbonNode?.remove(); ribbonNode = null; return; }
    if (ribbonNode && ribbonNode.textContent === text) return;
    ribbonNode?.remove();
    ribbonNode = el('div.ribbon', { role: 'status', text });
    root.append(ribbonNode);
  }

  function setHint(text: string | null): void {
    if (!text) { hintNode?.remove(); hintNode = null; return; }
    if (hintNode && hintNode.dataset.text === text) return;
    hintNode?.remove();
    hintNode = el('div.hint', { role: 'status', html: text, dataText: text });
    root.append(hintNode);
  }

  let lastState: GameState | null = null;
  let lastUi: UiState | null = null;
  const repatch = (): void => { if (lastState && lastUi) patch(lastState, lastUi); };
  window.addEventListener('resize', repatch);
  window.addEventListener('orientationchange', () => setTimeout(repatch, 150));

  /**
   * Restart a one-shot animation class even when the element already carries it.
   * The reflow matters: re-adding a class in the same frame does not restart the
   * animation, and a creature struck twice in one combat would only flash once.
   * The timer backstop matters too: under reduced motion the animation is `none`,
   * so animationend never fires and the class would stick for the rest of the game.
   */
  function flash(node: HTMLElement, cls: string, timeoutMs: number): void {
    node.classList.remove(cls);
    reflow(node);
    node.classList.add(cls);
    node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
    setTimeout(() => node.classList.remove(cls), timeoutMs);
  }

  function clashTile(card: CardId): void {
    const tile = tiles.get(card);
    if (tile) flash(tile, 'tile--clash', 500);
  }

  /** The mana row's lands button — where a played land visibly ends up. */
  const manaHome = (you: boolean): HTMLElement | null =>
    (you ? youMana : oppMana).querySelector<HTMLElement>('.mana__lands');

  /** Where a flight out of a player's hand starts: your card, or their card backs. */
  function handOrigin(card: CardId, you: boolean): HandSpot | null {
    if (!snap) return null;
    if (you) return snap.hand.get(card) ?? null;
    return { rect: rectAt(centerOf(snap.backs), 34, 47), rot: 0 };
  }

  /**
   * The face a ghost leaving your hand wears: the departed card's own <img>, adopted
   * whole. A freshly created image — even a cached one — can paint a frame or two
   * late while it decodes, which reads as the card blinking out and reloading mid
   * flight. The element that was already on screen cannot.
   */
  function handGhost(card: CardId, image: string): HTMLElement {
    const img = departed.get(card)?.querySelector('img');
    if (img) return el('div.fx__card', {}, img);
    return ghostCard(image);
  }

  /**
   * The ghost has landed: the tile fades up and settles where the flight left it.
   * Deliberately NOT the summon animation — the flight already was the entrance,
   * and replaying a second pop on top of it read as the card arriving twice.
   */
  function revealTile(tile: HTMLElement): void {
    tile.style.opacity = '';
    tile.classList.remove('tile--entering');
    flash(tile, 'tile--landed', 400);
  }

  return {
    root,
    patch(state: GameState, ui: UiState) { lastState = state; lastUi = ui; patch(state, ui); },
    tileFor: card => tiles.get(card),
    ribbon: setRibbon,
    clash: clashTile,

    snapshot() {
      const stackArts = new Map<CardId, DOMRect>();
      for (const row of stack.querySelectorAll<HTMLElement>('.stack__item')) {
        const art = row.querySelector<HTMLElement>('.stack__art');
        if (row.dataset.card && art) stackArts.set(row.dataset.card, art.getBoundingClientRect());
      }
      const handSpots = new Map<CardId, HandSpot>();
      for (const [id, node] of handCards) {
        // The bounding rect of a rotated card is bigger than the card. Normalise to
        // the unrotated box around the same centre and remember the angle, so the
        // ghost starts exactly on the card instead of on its bounding box.
        handSpots.set(id, {
          rect: rectAt(centerOf(node.getBoundingClientRect()), node.offsetWidth, node.offsetHeight),
          rot: parseFloat(node.style.getPropertyValue('--rot')) || 0,
        });
      }
      snap = {
        hand: handSpots,
        tiles: new Map([...tiles].map(([id, node]) => [id, node.getBoundingClientRect()])),
        stackArts,
        backs: backs.getBoundingClientRect(),
        libYou: youRail.querySelector('.js-lib')?.getBoundingClientRect() ?? null,
        libThem: oppRail.querySelector('.js-lib')?.getBoundingClientRect() ?? null,
      };
      departed.clear();
      // Freeze the combat stances currently on screen; the coming repaint would
      // otherwise clear them before the blows they explain have played.
      poses.clear();
      for (const [id, tile] of tiles) {
        if (tile.classList.contains('tile--attacking')) poses.set(id, 'attacking');
        else if (tile.classList.contains('tile--blocking')) poses.set(id, 'blocking');
      }
    },

    holdForDeaths(cards) {
      for (const id of cards) if (tiles.has(id)) held.add(id);
    },

    releaseHeld() {
      for (const id of held) {
        const tile = tiles.get(id);
        tiles.delete(id);
        if (tile) {
          tile.classList.add('tile--dying');
          setTimeout(() => tile.remove(), 400);
        }
      }
      held.clear();
      // The batch is over: survivors ease home, tap and dim on their transitions.
      if (poses.size) {
        poses.clear();
        repatch();
      }
    },

    perish(card, opts) {
      held.delete(card);
      const tile = tiles.get(card);
      if (!tile) return;
      tiles.delete(card);

      const from = tile.getBoundingClientRect();
      const art = tile.querySelector<HTMLImageElement>('.tile__art')?.src ?? '';
      tile.remove();
      if (opts.instant || !art) return;

      const yard = mid.querySelector<HTMLElement>('.yard button');
      if (opts.toGrave && yard) {
        // Yours travel to the graveyard button, so "Grave 3" becomes a place cards
        // visibly go rather than a counter that changes on its own.
        fly(fx, ghostCard(art), {
          from, to: yard.getBoundingClientRect(), duration: 400, arc: 20, settleOpacity: 0.2,
        });
      } else {
        // The Magician's graveyard has no button to travel to; theirs just fall apart.
        dissolve(fx, ghostCard(art), from, 400);
      }
    },

    strike(source, target, sourceYours) {
      const targetNode = target.kind === 'tile' ? tiles.get(target.id) : target.you ? youRail : oppRail;
      if (!targetNode) return 0;
      // A player is hit in their life total, not in the middle of their whole rail —
      // the ring lands where the number is about to change, next to the floaty.
      const lifeNode = target.kind === 'rail' ? targetNode.querySelector<HTMLElement>('.rail__life') : null;
      const contact = centerOf((lifeNode ?? targetNode).getBoundingClientRect());

      const land = (): void => {
        impactRing(fx, contact);
        if (target.kind === 'tile') clashTile(target.id);
        else flash(targetNode, 'rail--struck', 400);
      };

      // A creature strikes with its body; a spell arrives as a bolt from where it sat
      // on the stack — or, when it was cast and resolved in one breath, from the hand
      // it left. Damage with no origin at all still marks its point of impact.
      const sourceTile = tiles.get(source);
      if (sourceTile) {
        const delay = peck(sourceTile, contact, 240);
        setTimeout(land, delay);
        return delay;
      }
      const origin = snap?.stackArts.get(source) ?? handOrigin(source, sourceYours)?.rect;
      if (origin) {
        bolt(fx, centerOf(origin), contact, 190, land);
        return 190;
      }
      land();
      return 0;
    },

    pulse(card) {
      const tile = tiles.get(card);
      if (tile) flash(tile, 'tile--pulsed', 600);
    },

    flyDraw(you, card) {
      const from = you ? snap?.libYou : snap?.libThem;
      if (!from) return;
      const dest = you
        ? handCards.get(card)?.getBoundingClientRect() ?? rectAt(centerOf(hand.getBoundingClientRect()), 108, 150)
        : rectAt(centerOf(backs.getBoundingClientRect()), 34, 47);
      fly(fx, ghostBack(), {
        from: rectAt(centerOf(from), 30, 42), to: dest, duration: 200, arc: 12, settleOpacity: 0.4,
      });
    },

    flyPlay(card, image, you) {
      const from = handOrigin(card, you);
      const home = manaHome(you);
      if (!from || !home) return;
      fly(fx, handGhost(card, image), {
        from: from.rect, fromRotation: from.rot,
        to: home.getBoundingClientRect(), duration: 300, arc: 22, settleOpacity: 0,
      });
    },

    flyFromHand(card, image, you, dest) {
      const from = handOrigin(card, you);
      if (!from) return;
      const ghost = handGhost(card, image);

      if (dest === 'stack') {
        const row = stack.querySelector<HTMLElement>(`.stack__item[data-card="${card}"] .stack__art`);
        if (row) {
          fly(fx, ghost, {
            from: from.rect, fromRotation: from.rot,
            to: row.getBoundingClientRect(), duration: 280, arc: 18, settleOpacity: 0.1,
          });
          return;
        }
        dest = 'mid';
      }

      if (dest === 'board') {
        const tile = tiles.get(card);
        if (tile) {
          tile.style.opacity = '0';
          fly(fx, ghost, {
            from: from.rect, fromRotation: from.rot,
            to: tile.getBoundingClientRect(), duration: 280, arc: 18, settleOpacity: 0.35,
            onArrive: () => revealTile(tile),
          });
          return;
        }
        dest = 'mid';
      }

      if (dest === 'grave') {
        const yard = mid.querySelector<HTMLElement>('.yard button');
        if (yard) {
          fly(fx, ghost, {
            from: from.rect, fromRotation: from.rot,
            to: yard.getBoundingClientRect(), duration: 280, arc: 18, settleOpacity: 0.2,
          });
          return;
        }
        dest = 'mid';
      }

      // A spell with no home to show: it happens at mid-table and fades there.
      fly(fx, ghost, {
        from: from.rect, fromRotation: from.rot,
        to: rectAt(centerOf(mid.getBoundingClientRect()), 56, 40),
        duration: 280, arc: 18, settleOpacity: 0,
      });
    },

    flyResolve(card, art, to) {
      const from = snap?.stackArts.get(card);
      if (!from) return;

      if (to.kind === 'battlefield') {
        const tile = tiles.get(card);
        if (tile) {
          // Already on the table before this batch means this is a trigger resolving,
          // not an arrival — nothing travelled, so nothing should fly.
          if (snap?.tiles.has(card)) return;
          tile.style.opacity = '0';
          fly(fx, ghostCard(art), {
            from, to: tile.getBoundingClientRect(), duration: 240, arc: 16, settleOpacity: 0.35,
            onArrive: () => revealTile(tile),
          });
          return;
        }
        // No tile of its own — an aura lands on its creature; anything else fades out
        // where it resolved rather than pretending to have a home on screen.
        const host = to.attachedTo ? tiles.get(to.attachedTo) : undefined;
        if (host) {
          fly(fx, ghostCard(art), {
            from, to: host.getBoundingClientRect(), duration: 240, arc: 16, settleOpacity: 0,
            onArrive: () => flash(host, 'tile--pulsed', 600),
          });
          return;
        }
        dissolve(fx, ghostCard(art), from, 240);
        return;
      }

      const yard = mid.querySelector<HTMLElement>('.yard button');
      if (to.kind === 'grave' && yard) {
        fly(fx, ghostCard(art), {
          from, to: yard.getBoundingClientRect(), duration: 260, arc: 14, settleOpacity: 0.2,
        });
        return;
      }
      dissolve(fx, ghostCard(art), from, 260);
    },

    fizzle(card, art) {
      const from = snap?.stackArts.get(card);
      if (!from) return;
      const ghost = ghostCard(art);
      ghost.classList.add('fx__fizzle');
      dissolve(fx, ghost, from, 300);
    },
    refuse(card) {
      const node = handCards.get(card);
      if (!node) return;
      // Restarted rather than queued: a second refusal of the same card has to be
      // visible, and re-adding a class the element already carries does nothing.
      node.classList.remove('hand__card--refused');
      void node.offsetWidth;
      node.classList.add('hand__card--refused');
      // Timer, not animationend. Under reduced motion the animation is `none`, so
      // animationend never fires and the class sticks to the card for the rest of the
      // game — the one player who asked for less movement being the one left with a
      // permanently flagged card.
      setTimeout(() => node.classList.remove('hand__card--refused'), 320);
    },
    banner(text) {
      // Replaced rather than queued: if two turns pass faster than the sweep, the
      // player wants the current one, not a backlog of stale announcements.
      root.querySelector('.banner')?.remove();
      const node = el('div.banner', { role: 'status', text });
      root.append(node);
      setTimeout(() => node.remove(), 1100);
    },
    floaty(text, kind, anchor) {
      const node = el('div.floaty', { text });
      node.classList.add(`floaty--${kind}`);
      node.style.right = '16px';
      node.style.top = anchor === 'opponent' ? '20px' : 'calc(100% - 190px)';
      root.append(node);
      setTimeout(() => node.remove(), 1000);
    },
  };
}

/* ------------------------------------------------------------------ rails */

function patchRail(
  node: HTMLElement, state: GameState, player: PlayerId, isYou: boolean,
  ui: UiState, callbacks: TableCallbacks,
): void {
  const p = state.players[player];
  const active = state.active === player;
  node.classList.toggle('rail--active', active);

  let life = node.querySelector<HTMLElement>('.rail__life');
  if (!life) {
    node.append(
      el('div.rail__avatar', { 'aria-hidden': 'true', text: isYou ? '✦' : '✧' }),
      el('div.rail__who',
        el('div.rail__name', { text: isYou ? 'You' : 'The Magician' }),
        el('div.rail__counts',
          el('span', {}, el('i.rail__icon', { 'aria-hidden': 'true' }), el('b.js-hand', { text: '0' })),
          el('span', {}, el('i.rail__icon', { 'aria-hidden': 'true' }), el('b.js-lib', { text: '0' })),
          el('span.rail__status.js-status', { text: '' }),
        ),
      ),
    );
    life = el('div.rail__life', { role: 'status' });
    node.append(life);
  }

  const previous = Number(life.textContent);
  if (previous !== p.life) {
    life.textContent = String(p.life);
    if (!Number.isNaN(previous)) {
      const cls = p.life < previous ? 'rail__life--hit' : 'rail__life--gain';
      life.classList.add(cls);
      setTimeout(() => life!.classList.remove(cls), 420);
    }
  }
  const incoming = ui.incoming && ui.incoming.player === player ? ui.incoming.amount : 0;
  let preview = node.querySelector<HTMLElement>('.rail__incoming');
  if (incoming > 0) {
    if (!preview) {
      preview = el('div.rail__incoming', { 'aria-hidden': 'true' });
      life.parentElement?.insertBefore(preview, life);
    }
    preview.textContent = `−${incoming}`;
    life.classList.add('rail__life--threatened');
  } else {
    preview?.remove();
    life.classList.remove('rail__life--threatened');
  }

  life.setAttribute('aria-label',
    incoming > 0
      ? `${isYou ? 'Your' : "The Magician's"} life total: ${p.life}, taking ${incoming} unless blocked, leaving ${p.life - incoming}`
      : `${isYou ? 'Your' : "The Magician's"} life total: ${p.life}`);

  node.querySelector('.js-hand')!.textContent = String(p.hand.length);
  node.querySelector('.js-lib')!.textContent = String(p.library.length);
  // "your turn" would sit exactly where the action button lives — and it is triple
  // redundant with the gold rail edge, the enabled gold button and the turn banner.
  // The opponent's rail keeps its status: nothing else occupies that slot.
  node.querySelector('.js-status')!.textContent =
    state.winner !== null || isYou ? '' : active ? 'thinking…' : '';

  // A rail becomes a tap target only while a spell can actually point at it, so the
  // whole bar lights up rather than asking the player to find a small hitbox.
  const targetable = ui.targetablePlayers.has(player);
  node.classList.toggle('rail--targetable', targetable);
  node.classList.toggle(
    'rail--over',
    targetable && ui.over?.kind === 'player' && ui.over.id === player,
  );
  if (targetable && !node.dataset.wired) {
    node.dataset.wired = 'yes';
    node.addEventListener('click', () => {
      if (node.classList.contains('rail--targetable')) callbacks.onRailTap(player);
    });
  }
}

/* ------------------------------------------------------------------- mana */

function patchMana(
  node: HTMLElement, state: GameState, player: PlayerId, isYou: boolean, callbacks: TableCallbacks,
): void {
  const lands = cardsIn(state, player, 'battlefield').filter(id => def(state, id).cardTypes.includes('land'));
  const pool = availableMana(state, player);

  /*
   * One pill per color: an icon, a count, on the color. "Two Forests" reads as a tree,
   * a 2, and a green pill — which a beginner can say out loud. The row of anonymous
   * dots it replaces could only answer "how many lands", never "how many of WHAT",
   * and what is the entire question when deciding if a card is castable.
   *
   * The number is the mana available right now: it falls as lands tap and the pill
   * dims when a color is spent dry, so the row doubles as the turn's spend meter.
   */
  const total = new Map<Color | 'C', number>();
  for (const id of lands) {
    const produces = def(state, id).producesMana?.[0] ?? 'C';
    total.set(produces, (total.get(produces) ?? 0) + 1);
  }

  /*
   * Repaint only when the row would actually change. This is what lets a pill ANIMATE
   * its change: the drain flash and the grow pop are classes on freshly built pills,
   * and rebuilding the row on every animation beat would cut them off mid-play. The
   * signature also carries enough to diff — a color whose available count fell since
   * the last paint flashes as spent, one that rose (an untap, a land played) pops in.
   */
  const signature =
    [...total].map(([c, n]) => `${c}:${n}:${pool[c] ?? 0}`).join(',') + `|${lands.length}`;
  const previous = new Map<string, number>();
  const hadPrevious = node.dataset.sig !== undefined;
  if (node.dataset.sig === signature) return;
  for (const part of (node.dataset.sig ?? '').split('|')[0]!.split(',')) {
    const [color, , untapped] = part.split(':');
    if (color) previous.set(color, Number(untapped));
  }
  node.dataset.sig = signature;

  clear(node);
  node.append(el('span.mana__label', { 'aria-hidden': 'true', text: 'mana' }));

  const said: string[] = [];
  for (const [color, count] of total) {
    const untapped = pool[color] ?? 0;
    const key = color.toLowerCase();
    const pill = el('span.manapill', { 'aria-hidden': 'true' });
    pill.classList.add(`manapill--${key}`);
    if (untapped === 0) pill.classList.add('manapill--dry');
    if (hadPrevious) {
      const before = previous.get(color);
      if (before !== undefined && untapped < before) pill.classList.add('manapill--drained');
      else if (before === undefined || untapped > before) pill.classList.add('manapill--grew');
    }
    pill.append(
      el<HTMLImageElement>('img.manapill__icon', {
        src: `mana/${key}.png`, alt: '', width: '18', height: '18',
      }),
      el('b', { text: String(untapped) }),
    );
    node.append(pill);
    said.push(`${untapped} of ${count} ${COLOR_NAME[color]}`);
  }

  node.setAttribute('aria-label',
    `${isYou ? 'Your' : "The Magician's"} mana: ${said.length ? said.join(', ') : 'none yet'}`);

  const button = el('button.mana__lands', {
    type: 'button', text: `${lands.length} ${lands.length === 1 ? 'land' : 'lands'}`,
  });
  if (isYou) button.addEventListener('click', () => callbacks.onManaTap(player));
  node.append(button);
}

const COLOR_NAME: Record<Color | 'C', string> = {
  W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless',
};


/* ------------------------------------------------------------ battlefield */

function patchBoard(
  node: HTMLElement, state: GameState, player: PlayerId, ui: UiState,
  tiles: Map<CardId, HTMLElement>, held: ReadonlySet<CardId>,
  poses: ReadonlyMap<CardId, 'attacking' | 'blocking'>, callbacks: TableCallbacks,
): void {
  const creatures = cardsIn(state, player, 'battlefield').filter(id => isCreature(state, id));

  // An empty board should not hold half the screen. Weight is deliberately compressed
  // rather than proportional: a board of four against a board of one would otherwise
  // squeeze the lone creature into a sliver.
  node.style.flexGrow = String(Math.min(2.2, 0.6 + creatures.length * 0.4));
  node.setAttribute('aria-label',
    `${player === ui.you ? 'Your' : "The Magician's"} battlefield, ${creatures.length} creatures`);

  let row = node.querySelector<HTMLElement>('.board__row');
  if (!row) { row = el('div.board__row'); node.append(row); }

  const present = new Set(creatures);
  for (const [id, tile] of tiles) {
    if (!present.has(id) && tile.parentElement === row) {
      // A creature whose DIE beat has not played yet stays standing — still lunged,
      // still wearing its last state — so the blow that kills it lands on a body.
      // `perish` removes it on its beat; everything else (a bounce, an exile) leaves
      // immediately with the death animation, as before.
      if (held.has(id)) continue;
      tile.classList.add('tile--dying');
      setTimeout(() => tile.remove(), 400);
      tiles.delete(id);
    }
  }

  creatures.forEach((id, index) => {
    let tile = tiles.get(id);
    if (!tile) {
      tile = buildTile(id, callbacks);
      tile.classList.add('tile--entering');
      // Clear it once it has played. Left on, the summon animation replays every time
      // the node is re-inserted to keep the row in order, which reads as a flicker.
      tile.addEventListener('animationend', () => tile!.classList.remove('tile--entering'), { once: true });
      tiles.set(id, tile);
    }
    if (row!.children[index] !== tile) row!.insertBefore(tile, row!.children[index] ?? null);
    updateTile(tile, state, id, ui, poses.get(id));
  });
}

/**
 * Make the creature tiles as large as they can be without overflowing their board.
 *
 * This measures rather than predicts. An earlier version computed the width from the
 * count, the gap and the aspect ratio — and got it wrong, because the real height of a
 * tile also depends on the name row, whose font size itself scales with the tile. One
 * pixel of error changes how many tiles fit per row, which changes the row count,
 * which blows the height budget entirely.
 *
 * So: start at the largest size that could possibly fit, ask the browser how tall the
 * result actually is, and step down until it fits. It converges in a handful of passes
 * and it cannot be wrong, because the answer comes from layout rather than from
 * arithmetic about layout.
 */
const TILE_MIN = 46;
const TILE_MAX = 190;

function sizeTiles(board: HTMLElement): void {
  const row = board.querySelector<HTMLElement>('.board__row');
  const count = board.querySelectorAll('.tile').length;
  if (!row || count === 0) return;

  const style = getComputedStyle(board);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const budget = board.clientHeight - padY;
  if (budget <= 0) return;

  // The width every tile currently wears, so the change can be animated below.
  const before = parseFloat(board.style.getPropertyValue('--tile-w')) || 0;

  // Transitions off while measuring: the loop sets a width and immediately reads the
  // resulting height, and an in-flight transition would make it measure the old
  // layout — the loop then never sees its own effect and shrinks everything to the
  // minimum.
  board.classList.add('board--measuring');

  let width = TILE_MAX;
  board.style.setProperty('--tile-w', `${width}px`);

  // Geometric descent: big steps first so a badly oversized board settles quickly,
  // then finer ones. Bounded, so this can never spin.
  for (let pass = 0; pass < 12 && width > TILE_MIN; pass++) {
    if (row.scrollHeight <= budget) break;
    width = Math.max(TILE_MIN, Math.floor(width * 0.86));
    board.style.setProperty('--tile-w', `${width}px`);
  }

  // Measurement done. If the answer moved, walk back to the old width, re-enable
  // transitions and set the new one — so a creature arriving resizes its neighbours
  // smoothly instead of snapping every tile on the board in one frame.
  if (before > 0 && Math.abs(width - before) > 1) {
    board.style.setProperty('--tile-w', `${before}px`);
    reflow(row);
    board.classList.remove('board--measuring');
    board.style.setProperty('--tile-w', `${width}px`);
  } else {
    board.classList.remove('board--measuring');
  }
}

function buildTile(id: CardId, callbacks: TableCallbacks): HTMLElement {
  const tile = el('button.tile', { type: 'button', dataCard: id },
    el('div.tile__frame', {},
      el('img.tile__art', { alt: '', draggable: 'false' }),
      el('div.tile__keywords', { 'aria-hidden': 'true' }),
      el('div.tile__pt', { 'aria-hidden': 'true' }),
    ),
    el('div.tile__name'),
  );
  tile.addEventListener('click', () => callbacks.onTileTap(id));
  return tile;
}

function updateTile(
  tile: HTMLElement, state: GameState, id: CardId, ui: UiState,
  pose?: 'attacking' | 'blocking',
): void {
  const card = inst(state, id);
  const d = def(state, id);
  const power = powerOf(state, id);
  const toughness = toughnessOf(state, id);
  const remaining = toughness - card.damage;

  const img = tile.querySelector<HTMLImageElement>('.tile__art')!;
  const src = card.isToken ? (card.tokenSpec?.art ?? '') : d.art;
  if (src && img.getAttribute('src') !== src) {
    img.src = src;
    // A missing image must leave a readable card, not a hole.
    img.onerror = () => { img.style.display = 'none'; tile.classList.add('tile--artless'); };
  }

  tile.querySelector('.tile__name')!.textContent = card.isToken ? (card.tokenSpec?.name ?? d.name) : d.name;

  const pt = tile.querySelector<HTMLElement>('.tile__pt')!;
  pt.textContent = `${power}/${remaining}`;
  pt.classList.toggle('tile__pt--buffed', power > (d.power ?? 0));
  pt.classList.toggle('tile__pt--hurt', card.damage > 0);

  const glyphs = tile.querySelector<HTMLElement>('.tile__keywords')!;
  const shown = GLYPH_PRIORITY.filter(k => hasKeyword(state, id, k)).slice(0, 3);
  const signature = shown.join(',');
  if (glyphs.dataset.signature !== signature) {
    glyphs.dataset.signature = signature;
    clear(glyphs);
    for (const k of shown) glyphs.append(el('i', { title: k, text: KEYWORD_GLYPH[k] ?? '' }));
  }

  // A frozen pose outranks the state: mid-batch the fight is still being SHOWN,
  // even though the engine has already moved on. Tapping and dimming wait for the
  // whole engagement — an attacker taps the moment it is declared, but a dimmed,
  // rotated card charging into battle reads as spent, not as fighting. It goes
  // visibly spent when the exchange is over, not while its blow is landing.
  const attacking = card.attacking || pose === 'attacking';
  const blocking = card.blocking !== undefined || pose === 'blocking';
  tile.classList.toggle('tile--tapped', card.tapped && !attacking && !blocking);
  tile.classList.toggle('tile--attacking', attacking);
  tile.classList.toggle('tile--blocking', blocking);
  setLunge(tile, attacking, blocking, card.controller === ui.you);
  tile.classList.toggle('tile--selected', ui.selected.has(id));
  tile.classList.toggle('tile--targetable', ui.targetable.has(id));
  // The one under the finger, marked apart from the ones merely eligible.
  tile.classList.toggle(
    'tile--over',
    ui.over?.kind === 'card' && ui.over.id === id && ui.targetable.has(id),
  );
  tile.classList.toggle('tile--sick',
    card.summonedThisTurn && !hasKeyword(state, id, 'haste') && card.controller === ui.you);

  const counters = card.counters['+1/+1'] - card.counters['-1/-1'];
  let badge = tile.querySelector<HTMLElement>('.tile__counters');
  if (counters > 0) {
    if (!badge) {
      badge = el('div.tile__counters');
      (tile.querySelector('.tile__frame') ?? tile).append(badge);
    }
    badge.textContent = `+${counters}`;
  } else badge?.remove();

  tile.setAttribute('aria-label', describeCreature(state, id, ui));
}

/**
 * How far this creature travels when it charges.
 *
 * Measured from where the tile actually is to the middle strip, so a creature on the
 * far edge of a wide board travels further than one already near the centre and they
 * arrive together. A fixed offset makes every card nudge by the same amount, which
 * reads as a twitch rather than as a charge.
 *
 * Blockers move half as far, so the two sides visibly meet in the middle instead of
 * one crossing the whole gap.
 */
function setLunge(tile: HTMLElement, attacking: boolean, blocking: boolean, isYours: boolean): void {
  if (!attacking && !blocking) {
    tile.style.removeProperty('--lunge');
    return;
  }

  const strip = tile.closest('.table')?.querySelector<HTMLElement>('.mid');
  if (!strip) return;

  // offsetTop, not getBoundingClientRect. A rect includes transforms, so a creature
  // measured while its summon animation is still playing reports where it is being
  // drawn rather than where it lives — and charges the wrong distance for the rest of
  // combat. Layout offsets ignore transforms entirely.
  const top = offsetWithin(tile);
  const stripTop = offsetWithin(strip);

  const gap = isYours
    ? (stripTop + strip.offsetHeight) - top
    : stripTop - (top + tile.offsetHeight);

  // Blockers travel less far, so the two sides meet in the middle rather than one
  // crossing the whole gap.
  //
  // No floor. A creature already sitting against the centre line has nowhere to go,
  // and forcing a minimum shoves it under the phase rail where it mostly disappears.
  // For those, the emphasis comes from the scale, the ring and the clash flash instead
  // — which is honest, because a creature at the front of the board really has already
  // arrived.
  const travel = gap * (blocking ? 0.35 : 0.62);

  tile.style.setProperty('--lunge', `${Math.round(travel)}px`);
}

/** Distance from the table's top edge, following offsetParent rather than transforms. */
function offsetWithin(node: HTMLElement): number {
  let y = 0;
  let current: HTMLElement | null = node;
  while (current && !current.classList.contains('table')) {
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return y;
}

/** What a screen reader hears. Includes the state a sighted player reads from the
 *  tile's rotation and dimming, which is why tapped and sick are spelled out. */
function describeCreature(state: GameState, id: CardId, ui: UiState): string {
  const card = inst(state, id);
  const d = def(state, id);
  const keywords = GLYPH_PRIORITY.filter(k => hasKeyword(state, id, k));
  const parts = [
    card.isToken ? (card.tokenSpec?.name ?? d.name) : d.name,
    `${powerOf(state, id)} over ${toughnessOf(state, id) - card.damage}`,
  ];
  if (keywords.length) parts.push(keywords.join(', '));
  if (card.tapped) parts.push('tapped');
  if (card.attacking) parts.push('attacking');
  if (card.blocking) parts.push('blocking');
  if (card.summonedThisTurn && !hasKeyword(state, id, 'haste')) parts.push('summoning sick');
  parts.push(card.controller === ui.you ? 'yours' : "the Magician's");
  return parts.join(', ');
}

/* -------------------------------------------------------------------- mid */

function patchMid(node: HTMLElement, state: GameState, you: PlayerId, callbacks: TableCallbacks): void {
  let phases = node.querySelector<HTMLElement>('.phases');
  if (!phases) {
    const gy = el<HTMLButtonElement>('button', { type: 'button', 'aria-label': 'Your graveyard' });
    gy.addEventListener('click', () => callbacks.onZoneTap('graveyard', you));
    const ex = el<HTMLButtonElement>('button', { type: 'button', 'aria-label': 'Exile' });
    ex.addEventListener('click', () => callbacks.onZoneTap('exile', you));

    phases = el('div.phases', { role: 'status' });
    for (const phase of RAIL_PHASES) {
      phases.append(el('b', { dataPhase: phase }));
    }
    node.append(el('div.yard', {}, gy), phases, el('div.yard', {}, ex));
  }

  // Combat's four steps all light the one combat slot, so the rail stays legible.
  const index = PHASE_ORDER.indexOf(state.phase);
  const combatStart = PHASE_ORDER.indexOf('beginCombat');
  const combatEnd = PHASE_ORDER.indexOf('endCombat');
  const shown = index >= combatStart && index <= combatEnd ? 'declareAttackers' : state.phase;

  for (const b of phases.querySelectorAll<HTMLElement>('b')) {
    const on = b.dataset.phase === shown;
    b.classList.toggle('on', on);
    // The word only exists on the lit segment; everything else collapses to a dot.
    b.textContent = on ? (PHASE_WORD[b.dataset.phase ?? ''] ?? b.dataset.phase ?? '') : '';
  }
  phases.setAttribute('aria-label', `Turn phase: ${PHASE_WORD[shown] ?? shown}`);

  node.querySelector('.yard button')!.textContent = `Grave ${state.players[you].graveyard.length}`;
  node.querySelectorAll('.yard button')[1]!.textContent = `Exile ${state.players[you].exile.length}`;
}

/* ------------------------------------------------------------------- hand */

function patchHand(
  node: HTMLElement, state: GameState, ui: UiState,
  cards: Map<CardId, HTMLElement>, departed: Map<CardId, HTMLElement>,
  actions: Action[], callbacks: TableCallbacks,
): void {
  const inHand = state.players[ui.you].hand;

  let label = node.querySelector<HTMLElement>('.hand__label');
  if (!label) { label = el('div.hand__label'); node.append(label); }
  label.textContent = `Hand · ${inHand.length}`;

  const playable = new Set(
    actions.filter(a => a.kind === 'castSpell' || a.kind === 'playLand').map(a => a.card),
  );

  const present = new Set(inHand);
  for (const [id, card] of cards) {
    if (!present.has(id)) {
      card.remove();
      cards.delete(id);
      // Kept for the length of the batch: a flight out of the hand adopts this
      // node's <img> so the ghost wears an already-decoded face.
      departed.set(id, card);
    }
  }

  /*
   * The fan.
   *
   * Cards are large and hang off the bottom of the screen: their name-and-cost band is
   * what shows, which is exactly the part of a hand you actually consult mid-game —
   * reading rules text goes through the long-press reader either way, so pixels spent
   * on a whole miniature card were pixels spent on a card nobody could read.
   *
   * Geometry is computed here, not in CSS: rotation and lift both derive from the
   * card's offset from the fan's centre, and CSS cannot take abs() of a custom
   * property with useful support. Each card gets --x/--rot/--dip and the stylesheet
   * only composes them.
   */
  const n = inHand.length;
  const mid = (n - 1) / 2;
  const cardWidth = 104;
  const available = Math.max(240, node.clientWidth - 24);
  const spacing = n > 1 ? Math.min(cardWidth * 0.6, (available - cardWidth) / (n - 1)) : 0;

  inHand.forEach((id, index) => {
    let card = cards.get(id);
    if (!card) {
      const d = def(state, id);
      card = el('button.hand__card', { type: 'button', dataCard: id },
        el('img', { src: d.image, alt: '', draggable: 'false' }));
      card.addEventListener('click', () => callbacks.onHandTap(id));
      cards.set(id, card);
    }
    if (node.children[index + 1] !== card) node.insertBefore(card, node.children[index + 1] ?? null);

    const off = index - mid;
    card.style.setProperty('--x', `${Math.round(off * spacing)}px`);
    // A card in the air has straightened, and it must stay straight: the renderer runs
    // again on every drag frame, and rewriting the fan angle here would fight the lift
    // the gesture layer just applied — inline against inline, forty times a second.
    if (!card.classList.contains('hand__card--dragging')) {
      card.style.setProperty('--rot', `${(off * 4).toFixed(1)}deg`);
    }
    card.style.setProperty('--dip', `${Math.round(Math.abs(off) * off * 0.9 + Math.abs(off) * 7)}px`);
    card.style.zIndex = String(10 + index);

    const castable = playable.has(id);
    card.classList.toggle('hand__card--playable', castable);
    card.classList.toggle('hand__card--dim', !castable && !canCast(state, id));
    card.setAttribute('aria-label', describeHandCard(state, id, castable));
  });
}

/** A hand card announces cost and body, then whether it can be cast right now. */
function describeHandCard(state: GameState, id: CardId, castable: boolean): string {
  const d = def(state, id);
  const parts = [d.name, describeCost(d.manaCost), d.cardTypes.join(' ')];
  if (d.power !== undefined) parts.push(`${d.power} over ${d.toughness}`);
  parts.push(castable ? 'playable now' : 'not playable yet');
  return parts.filter(Boolean).join(', ');
}

function describeCost(cost: Record<string, number | undefined>): string {
  const said: string[] = [];
  const generic = cost['C'] ?? 0;
  if (generic) said.push(`${generic} generic`);
  const names: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  for (const [sym, word] of Object.entries(names)) {
    const n = cost[sym] ?? 0;
    if (n) said.push(`${n} ${word}`);
  }
  return said.length ? `costs ${said.join(' and ')}` : 'free';
}

function patchBacks(node: HTMLElement, state: GameState, them: PlayerId): void {
  const count = state.players[them].hand.length;
  if (node.childElementCount === count) return;
  clear(node);
  for (let i = 0; i < count; i++) node.append(el('i', { 'aria-hidden': 'true' }));
  node.setAttribute('aria-label', `The Magician holds ${count} cards`);
}
