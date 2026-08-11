/**
 * Overlays: card zoom, zone browsing, and the four decision panels.
 *
 * The battlefield deliberately strips the card frame away so the art can be large. The
 * cost of that is you can no longer read the card, so tapping anything shows the real
 * printed card, at a size worth looking at, with its illustrator credited.
 *
 * Two kinds of overlay live here and the difference is load-bearing. A **browser** —
 * the card zoom, a graveyard, the lands — is something the player asked to look at, so
 * a tap anywhere puts it away. A **panel** is a question the engine is waiting on: the
 * opening hand, the cards a scry just looked at, the order an attacker assigns damage
 * in. There is no state the game can be in where one of those questions has gone away,
 * so a panel has no background dismiss and no Escape. The only way out is to answer it.
 *
 * Nothing here decides legality and nothing here changes state. A panel reports the
 * choice back through a callback and the session turns it into an `Action`; the lands
 * panel asks `legalActions` which lands may be tapped, exactly as the table does.
 */

import type { CardId, Color, GameState, PlayerId } from '../engine/types';
import { MAX_MULLIGANS } from '../engine/types';
import { def, inst, powerOf, toughnessOf } from '../engine/state';
import { legalActions } from '../engine/actions';
import { el, clear } from './dom';
import { sound } from '../audio/kit';

/** Fixed order, so a floating symbol never jumps sideways when another appears. */
const MANA_KEYS: readonly (Color | 'C')[] = ['W', 'U', 'B', 'R', 'G', 'C'];

const COLOR_WORD: Record<Color | 'C', string> = {
  W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless',
};

let current: HTMLElement | null = null;
/** Torn down with the overlay, so a listener can never outlive the node it serves. */
let detach: (() => void) | null = null;
/**
 * Set by an overlay whose contents change while it is open — only the lands panel,
 * where tapping a land is supposed to visibly tap it. Everything else is a snapshot.
 */
let repaint: ((state: GameState) => void) | null = null;

function close(): void {
  if (!current) return;
  sound.play('zoom-close', { gain: 0.5 });
  detach?.();
  detach = null;
  repaint = null;
  current.remove();
  current = null;
}

/**
 * How an overlay is put away.
 *
 * `'anywhere'` is right for something that is only a picture — a card zoom, a
 * graveyard — where every tap on it means "seen it". It is exactly wrong for an
 * overlay with controls in it: the tap that taps a land would bubble to the backdrop
 * and close the panel out from under the player. Those dismiss on the backdrop only.
 * `'never'` is for a question the game is waiting on an answer to.
 */
type Dismiss = 'anywhere' | 'backdrop' | 'never';

/**
 * The card reader: its own layer, above whatever panel is open.
 *
 * `open()` replaces the current overlay, which is right for panels — only one question
 * can be in front of the player at a time. It is wrong for reading a card, because a
 * player reads a card *in order to answer* the panel underneath. Sharing one slot
 * would have meant tapping a card in your opening hand destroyed the opening hand.
 */
let reader: HTMLElement | null = null;
let detachReader: (() => void) | null = null;

function closeReader(): void {
  if (!reader) return;
  sound.play('zoom-close', { gain: 0.5 });
  detachReader?.();
  detachReader = null;
  reader.remove();
  reader = null;
}

function openReader(host: HTMLElement, content: HTMLElement, label: string): void {
  closeReader();
  sound.play('zoom-open', { gain: 0.6 });

  const layer = el('div.overlay.overlay--reader', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
  });
  layer.append(content);
  layer.addEventListener('click', () => closeReader());

  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') closeReader(); };
  window.addEventListener('keydown', onKey);
  detachReader = () => window.removeEventListener('keydown', onKey);

  host.append(layer);
  reader = layer;
}

function open(host: HTMLElement, content: HTMLElement, label: string, dismiss: Dismiss = 'anywhere'): void {
  close();
  sound.play('zoom-open', { gain: 0.6 });

  const overlay = el('div.overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  overlay.append(content);

  if (dismiss !== 'never') {
    overlay.addEventListener('click', (ev: MouseEvent) => {
      if (dismiss === 'anywhere' || ev.target === overlay) close();
    });
    // Escape is not reachable on a phone, but this is also a desktop-playable page.
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    detach = () => window.removeEventListener('keydown', onKey);
  }

  host.append(overlay);
  current = overlay;
}

/* ------------------------------------------------------------------ pieces */

/** A token has no `CardDef`, so name and face come from its spec instead. */
function nameOf(state: GameState, id: CardId): string {
  const card = inst(state, id);
  if (card.isToken) return card.tokenSpec?.name ?? 'Token';
  return def(state, id).name;
}

/** The art crop, which is what the battlefield shows. */
function artOf(state: GameState, id: CardId): string {
  const card = inst(state, id);
  if (card.isToken) return card.tokenSpec?.art ?? '';
  return def(state, id).art;
}

/** Power over remaining toughness, the two numbers a combat decision turns on. */
function statLine(state: GameState, id: CardId): string {
  return `${powerOf(state, id)}/${toughnessOf(state, id) - inst(state, id).damage}`;
}

interface PickOptions {
  src: string;
  label: string;
  /**
   * The badge drawn on a chosen card: a number, an arrow. `null` marks a card that
   * *could* be chosen and is not — which is what makes the control a toggle, and is
   * why omitting the field entirely (a land) leaves it a plain button instead.
   */
  mark?: string | null;
  /** Extra class, e.g. a tapped land or a blocker that is already dead. */
  variant?: string;
  caption?: string;
  /**
   * Power over remaining toughness, drawn on the art in the same corner the board
   * tiles use. Not part of the caption: a name and its stats on one line at this width
   * ellipsises the numbers away, and the numbers are the decision.
   */
  stat?: string;
  onTap?: (() => void) | null;
}

/**
 * One card as a choice. The whole card is the tap target — a picker made of small
 * checkboxes beside big cards is a picker nobody hits on a phone.
 */
function pick(options: PickOptions): HTMLElement {
  const node = el<HTMLButtonElement>('button.pick', { type: 'button', 'aria-label': options.label });
  node.append(el('span.pick__face', {},
    el<HTMLImageElement>('img', { src: options.src, alt: '' }),
    options.stat ? el('span.pick__pt', { 'aria-hidden': 'true', text: options.stat }) : null,
  ));
  if (options.caption) node.append(el('span.pick__caption', { text: options.caption }));

  if (options.mark !== undefined) {
    node.setAttribute('aria-pressed', String(options.mark !== null));
    if (options.mark !== null) {
      node.classList.add('pick--on');
      node.append(el('span.pick__mark', { 'aria-hidden': 'true', text: options.mark }));
    }
  }

  if (options.variant) node.classList.add(options.variant);
  if (options.onTap) node.addEventListener('click', options.onTap);
  else node.disabled = true;
  return node;
}

function panel(title: string, ...children: Array<Node | null>): HTMLElement {
  return el('div.panel', {}, el('div.panel__title', { text: title }), ...children);
}

function button(text: string, label: string, quiet = false): HTMLButtonElement {
  const node = el<HTMLButtonElement>('button.panel__button', {
    type: 'button', text, 'aria-label': label,
  });
  if (quiet) node.classList.add('panel__button--quiet');
  return node;
}

/* -------------------------------------------------------------------- zoom */

/** An action a card affords, offered from inside the enlarged view. */
export interface CardAction {
  label: string;
  /** Screen-reader text, since the visible label is often two words. */
  aria: string;
  run: () => void;
  quiet?: boolean;
}

/**
 * The full printed card, as large as the screen allows.
 *
 * This is the only place a card can actually be *read*, so it is worth the whole
 * viewport. The earlier version capped at 260px wide, which is legible for a name and
 * a mana cost and useless for rules text — and rules text is the entire reason a
 * beginner opens a card.
 *
 * Any action the card affords comes with it. That is what lets every other surface
 * treat a tap as "show me this" rather than as a commitment: you read the card at full
 * size and then decide, instead of deciding and then finding out.
 */
export function showCard(
  host: HTMLElement,
  state: GameState,
  card: CardId,
  actions: CardAction[] = [],
): void {
  const card_ = inst(state, card);
  const isToken = card_.isToken;
  const spec = card_.tokenSpec;
  const d = isToken ? null : def(state, card);

  const name = isToken ? (spec?.name ?? 'Token') : d!.name;
  const src = isToken ? (spec?.art ?? '') : d!.image;

  const image = el<HTMLImageElement>('img.overlay__card', { src, alt: name });
  if (isToken) image.classList.add('overlay__card--token');
  else image.onerror = () => { image.replaceWith(fallbackCard(state, card)); };

  const caption = isToken
    ? `${name} · ${spec?.power ?? 0}/${spec?.toughness ?? 0} token`
    : (d!.artist ? `Illustrated by ${d!.artist}` : '');

  const body = el('div.overlay__body', {},
    image,
    caption ? el('div.overlay__artist', { text: caption }) : null,
    actions.length ? cardActions(actions) : null,
  );

  openReader(host, body, name);
}

/**
 * The buttons under an enlarged card.
 *
 * They stop the tap from reaching the overlay backdrop, which closes on click —
 * otherwise choosing an action would also dismiss the card, and on a slow render the
 * player would see their own decision flicker away.
 */
function cardActions(actions: CardAction[]): HTMLElement {
  const row = el('div.overlay__actions', {});
  for (const action of actions) {
    const node = button(action.label, action.aria, action.quiet ?? false);
    node.addEventListener('click', ev => {
      ev.stopPropagation();
      closeReader();
      action.run();
    });
    row.append(node);
  }
  return row;
}

/**
 * If an image is missing, show the card as text rather than a hole. A player can still
 * make the decision in front of them from name, cost and rules text.
 */
function fallbackCard(state: GameState, card: CardId): HTMLElement {
  const d = def(state, card);
  return el('div.panel__fallback', {},
    el('div.panel__fallbackName', { text: d.name }),
    el('div.panel__fallbackType', { text: d.cardTypes.join(' ') }),
    el('div.panel__fallbackText', { text: d.oracleText || '—' }),
    d.power !== undefined
      ? el('div.panel__fallbackPt', { text: `${d.power}/${d.toughness}` })
      : null,
  );
}

/* ------------------------------------------------------------------- zones */

/** Graveyard and exile, as a scrollable grid of real cards. */
export function showZone(
  host: HTMLElement, state: GameState, zone: 'graveyard' | 'exile', player: PlayerId,
): void {
  const ids = state.players[player][zone];
  const grid = el('div.panel__grid');

  if (!ids.length) {
    grid.append(el('div.panel__empty', {
      text: zone === 'graveyard' ? 'Nothing has died yet.' : 'Nothing exiled.',
    }));
  }

  for (const id of ids) {
    const d = def(state, id);
    // A graveyard is a list of cards you are trying to remember the text of. Thumbnails
    // alone answered "how many", never "which".
    const thumb = el<HTMLButtonElement>('button.panel__thumbButton', {
      type: 'button', 'aria-label': `Read ${d.name}`,
    }, el<HTMLImageElement>('img.panel__thumb', { src: d.image, alt: '' }));
    thumb.addEventListener('click', ev => {
      ev.stopPropagation();
      showCard(host, state, id);
    });
    grid.append(thumb);
  }

  const body = el('div.panel', {},
    el('div.panel__caps', { text: `${zone} · ${ids.length}` }),
    grid,
  );
  open(host, body, `${zone}, ${ids.length} cards`);
}

/* ------------------------------------------------------------------- lands */

/**
 * The real lands behind the mana row, each untapped one tappable for mana.
 *
 * The row is a summary; this is where the abstraction gives way and shows the cards
 * they stand for, tapped ones rotated exactly as they would be on a table. Casting
 * taps lands for you (spec §9.3), so this exists for the player who wants the mana
 * floating *before* they decide what to spend it on — and for the player who taps a
 * land because tapping lands is what you do in Magic, and expects it to work.
 *
 * Which lands may be tapped is `legalActions` and nothing else, so a land offered here
 * is a land the engine will accept.
 */
function landsPanel(
  host: HTMLElement, state: GameState, player: PlayerId, onTap: (card: CardId) => void,
): { body: HTMLElement; paint: (state: GameState) => void; label: string } {
  const body = el('div.panel');
  let signature = '';

  const paint = (next: GameState): void => {
    const lands = next.players[player].battlefield.filter(id =>
      def(next, id).cardTypes.includes('land'));
    const tappable = new Set(
      legalActions(next)
        .filter(action => action.kind === 'tapLand')
        .map(action => action.card),
    );
    const pool = next.players[player].manaPool;
    const untapped = lands.filter(id => !inst(next, id).tapped).length;

    // Rebuilding on every render would reload every land image; the panel is repainted
    // from the same render loop as the table, so this is asked several times a beat.
    const now = [
      lands.map(id => `${id}${inst(next, id).tapped ? '*' : ''}${tappable.has(id) ? '+' : ''}`).join(','),
      MANA_KEYS.map(key => `${key}${pool[key] ?? 0}`).join(''),
    ].join('|');
    if (now === signature) return;
    signature = now;

    clear(body);
    body.append(el('div.panel__caps', {
      role: 'status', text: `lands · ${untapped} of ${lands.length} untapped`,
    }));

    const floating = MANA_KEYS.flatMap(key => Array.from({ length: pool[key] ?? 0 }, () => key));
    if (floating.length) {
      const row = el('div.panel__float', {
        role: 'status',
        'aria-label': `Floating mana: ${floating.map(key => COLOR_WORD[key]).join(', ')}`,
      }, el('span.panel__floatLabel', { 'aria-hidden': 'true', text: 'floating' }));
      for (const key of floating) {
        // Floating mana is mana, so it wears the same symbol the row and the deck
        // picker use. One vocabulary for colour across the whole app.
        row.append(el<HTMLImageElement>('img.manaicon', {
          src: `mana/${key.toLowerCase()}.png`, alt: '', width: '19', height: '19',
        }));
      }
      body.append(row);
    }

    const grid = el('div.panel__grid');
    if (!lands.length) {
      grid.append(el('div.panel__empty', {
        text: 'No lands yet. Playing one is the most important thing you do each turn.',
      }));
    }

    for (const id of lands) {
      const land = inst(next, id);
      const name = def(next, id).name;
      const makes = def(next, id).producesMana?.[0];
      const canTap = tappable.has(id);
      grid.append(pick({
        src: def(next, id).image,
        variant: land.tapped ? 'pick--spent' : undefined,
        label: land.tapped
          ? `${name}, already tapped`
          : canTap
            ? `${name}, tap for one ${makes ? COLOR_WORD[makes] : 'colorless'} mana`
            : `${name}, untapped`,
        // Always readable, even when it cannot be tapped — a land the player cannot
        // use is exactly the one they are most likely to want to look at.
        onTap: () => showCard(host, next, id, canTap
          ? [{ label: 'Tap for mana', aria: `Tap ${name} for one ${makes ? COLOR_WORD[makes] : 'colorless'} mana`, run: () => onTap(id) }]
          : []),
      }));
    }
    body.append(grid);

    body.append(el('div.panel__note', {
      text: lands.length
        ? 'Casting taps these for you. Tap one now to float its mana first.'
        : 'Mana comes from lands. One a turn, every turn.',
    }));
  };

  paint(state);
  const untapped = state.players[player].battlefield
    .filter(id => def(state, id).cardTypes.includes('land') && !inst(state, id).tapped).length;
  return { body, paint, label: `Lands, ${untapped} untapped` };
}

/* ---------------------------------------------------------------- mulligan */

/**
 * The opening hand, before turn one.
 *
 * London (spec §3): you always look at seven, and a keep puts back one card for every
 * mulligan already taken. So after the first mulligan this is two decisions in one
 * panel — whether to keep, and which cards to pay with — and the Keep button stays
 * disabled until the second one is finished, with the count said in words rather than
 * left for the player to work out from the highlights.
 */
function mulliganPanel(
  host: HTMLElement, state: GameState, player: PlayerId,
  onKeep: (toBottom: CardId[]) => void, onMulligan: () => void,
): HTMLElement {
  const hand = state.players[player].hand;
  const taken = state.players[player].mulligansTaken;
  const required = Math.min(taken, hand.length);
  const marked: CardId[] = [];

  const row = el('div.panel__row');
  const note = el('div.panel__note', { role: 'status' });
  const keep = button(`Keep ${hand.length - required}`, 'Keep');
  const mull = button('Mulligan', 'Mulligan', true);
  mull.disabled = taken >= MAX_MULLIGANS;
  mull.setAttribute('aria-label', taken >= MAX_MULLIGANS
    ? 'Mulligan. You have taken all of them.'
    : `Mulligan. Shuffle this hand back and draw seven new cards. `
      + `${MAX_MULLIGANS - taken} left.`);

  const paint = (): void => {
    const left = required - marked.length;

    clear(row);
    for (const id of hand) {
      const at = marked.indexOf(id);
      const chosen = at >= 0;
      const name = def(state, id).name;
      row.append(pick({
        src: def(state, id).image,
        mark: chosen ? '↓' : null,
        label: required === 0
          ? `${name}. Tap to read it.`
          : chosen
            ? `${name}, going to the bottom. Tap to read it, or to keep it instead.`
            : `${name}. Tap to read it, or to put it on the bottom.`,
        // A tap reads the card. You cannot decide whether to keep a hand you cannot
        // read, and at seven-across these faces are thumbnails — so the decision is
        // made from the enlarged view, where the rules text actually is.
        onTap: () => {
          const toggle = (): void => {
            if (chosen) marked.splice(at, 1);
            else {
              // Full already: the oldest pick makes room, so a player can always change
              // their mind by tapping the card they want rather than one they do not.
              if (marked.length >= required) marked.shift();
              marked.push(id);
            }
            sound.play('select');
            paint();
          };
          showCard(host, state, id, required === 0 ? [] : [{
            label: chosen ? 'Keep on top' : 'Put on the bottom',
            aria: chosen
              ? `Keep ${name} in your hand`
              : `Put ${name} on the bottom of your library`,
            run: toggle,
            quiet: chosen,
          }]);
        },
      }));
    }

    if (required === 0) {
      note.textContent = 'Two to four lands is a good keep. A hand with none is not.';
    } else if (left > 0) {
      note.textContent = `Tap ${left} more card${left === 1 ? '' : 's'} to put on the bottom.`;
    } else {
      note.textContent = `${required} card${required === 1 ? '' : 's'} going to the bottom. `
        + 'Tap one again to change your mind.';
    }
    if (taken >= MAX_MULLIGANS) note.textContent += ' That was the last mulligan.';

    keep.disabled = left !== 0;
    keep.setAttribute('aria-label', required === 0
      ? 'Keep this opening hand.'
      : left > 0
        ? `Keep. Choose ${left} more card${left === 1 ? '' : 's'} for the bottom first.`
        : `Keep, and put ${required} card${required === 1 ? '' : 's'} on the bottom.`);
  };

  keep.addEventListener('click', () => {
    if (keep.disabled) return;
    sound.play('button');
    close();
    onKeep([...marked]);
  });
  mull.addEventListener('click', () => {
    if (mull.disabled) return;
    sound.play('mulligan');
    close();
    onMulligan();
  });

  paint();
  return panel('Your opening hand', row, note, el('div.panel__buttons', {}, keep, mull));
}

/* -------------------------------------------------------------------- scry */

/**
 * The cards a scry looked at: each one goes to the top or to the bottom.
 *
 * Two buttons per card rather than a tap-to-toggle, because a scry is the first thing
 * in this game where the *default* is a real choice — a card left alone stays on top —
 * and a state you reach by not acting is a state the player should still see named.
 */
function scryPanel(
  host: HTMLElement, state: GameState, onDecide: (toBottom: CardId[]) => void,
): HTMLElement {
  const looked = state.pendingScry?.cards ?? [];
  const bottom = new Set<CardId>();

  const row = el('div.panel__row');
  const confirm = button('Confirm', 'Confirm');

  const paint = (): void => {
    clear(row);
    for (const id of looked) {
      const name = def(state, id).name;
      const goingDown = bottom.has(id);

      const top = el<HTMLButtonElement>('button.chip', {
        type: 'button', text: 'Top',
        'aria-pressed': String(!goingDown),
        'aria-label': `Leave ${name} on top of your library`,
      });
      const down = el<HTMLButtonElement>('button.chip', {
        type: 'button', text: 'Bottom',
        'aria-pressed': String(goingDown),
        'aria-label': `Send ${name} to the bottom of your library`,
      });
      top.addEventListener('click', () => { bottom.delete(id); sound.play('select'); paint(); });
      down.addEventListener('click', () => { bottom.add(id); sound.play('select'); paint(); });

      // The face reads the card; the two buttons stay as the fast path. A scry is a
      // decision about cards you have never seen — at this width the art is a hint and
      // the rules text is the answer.
      const face = el<HTMLButtonElement>('button.scry__face', {
        type: 'button', 'aria-label': `Read ${name}`,
      }, el<HTMLImageElement>('img.scry__card', { src: def(state, id).image, alt: '' }));
      face.addEventListener('click', ev => {
        ev.stopPropagation();
        showCard(host, state, id, [
          { label: 'Keep on top', aria: `Keep ${name} on top`, run: () => { bottom.delete(id); sound.play('select'); paint(); } },
          { label: 'To the bottom', aria: `Put ${name} on the bottom`, run: () => { bottom.add(id); sound.play('select'); paint(); }, quiet: true },
        ]);
      });

      row.append(el('div.scry', {}, face, el('div.scry__buttons', {}, top, down)));
    }

    const down = bottom.size;
    confirm.textContent = down === 0 ? 'Keep them on top' : `Bottom ${down}`;
    confirm.setAttribute('aria-label', down === 0
      ? `Confirm: all ${looked.length} card${looked.length === 1 ? '' : 's'} stay on top`
      : `Confirm: ${down} to the bottom, ${looked.length - down} on top`);
  };

  confirm.addEventListener('click', () => {
    sound.play('button');
    close();
    onDecide(looked.filter(id => bottom.has(id)));
  });

  paint();
  return panel(
    looked.length === 1 ? 'The top card of your library' : `The top ${looked.length} cards`,
    row,
    el('div.panel__note', {
      text: 'A card you send to the bottom is out of the way. Anything left on top is what you draw next.',
    }),
    el('div.panel__buttons', {}, confirm),
  );
}

/* ------------------------------------------------------------ damage order */

/**
 * The order one attacker assigns its damage in.
 *
 * Tap-to-order rather than drag: a drag on a phone competes with the scroll it lives
 * inside, and the numbers make the result readable without moving anything. Cards not
 * yet tapped keep the order they blocked in, so Confirm is always available and always
 * means something — this is a decision the attacker may decline to make.
 */
function blockerOrderPanel(
  host: HTMLElement, state: GameState, attacker: CardId, onConfirm: (order: CardId[]) => void,
): HTMLElement {
  // Every id in `blockedBy` must appear in the order — including a blocker killed by a
  // trick in the window before damage, which `combat.ts` skips but legality still counts.
  const blockers = [...inst(state, attacker).blockedBy];
  const chosen: CardId[] = [];
  const ordered = (): CardId[] => [...chosen, ...blockers.filter(id => !chosen.includes(id))];

  const row = el('div.panel__row.panel__row--tiles');
  const confirm = button('Confirm order', 'Confirm this damage order');

  const paint = (): void => {
    const order = ordered();
    clear(row);

    for (const id of blockers) {
      const at = chosen.indexOf(id);
      const place = order.indexOf(id) + 1;
      const gone = inst(state, id).zone !== 'battlefield';
      const name = nameOf(state, id);
      row.append(pick({
        src: artOf(state, id),
        caption: name,
        stat: statLine(state, id),
        mark: at >= 0 ? String(at + 1) : null,
        variant: gone ? 'pick--gone' : undefined,
        label: gone
          ? `${name} is already gone, and takes no damage`
          : `${name}, ${powerOf(state, id)} over ${toughnessOf(state, id) - inst(state, id).damage}, `
            + `takes damage ${place} of ${order.length}. Tap to move it up the order.`,
        // Reading comes first here too: which blocker you want dead depends on what
        // they are, and these are art crops with no rules text on them.
        onTap: () => {
          const move = (): void => {
            if (at >= 0) chosen.splice(at, 1);
            else chosen.push(id);
            sound.play('select');
            paint();
          };
          showCard(host, state, id, gone ? [] : [{
            label: at >= 0 ? 'Move back' : 'Take damage first',
            aria: at >= 0
              ? `Take ${name} out of the damage order`
              : `Put ${name} next in the damage order`,
            run: move,
            quiet: at >= 0,
          }]);
        },
      }));
    }

    confirm.setAttribute('aria-label',
      `Confirm damage order: ${order.map(id => nameOf(state, id)).join(', then ')}`);
  };

  confirm.addEventListener('click', () => {
    sound.play('button');
    close();
    onConfirm(ordered());
  });

  paint();
  return panel('Who takes damage first',
    el('div.panel__attacker', {},
      el<HTMLImageElement>('img.panel__attackerArt', { src: artOf(state, attacker), alt: '' }),
      el('div.panel__attackerName', {
        text: `${nameOf(state, attacker)} ${statLine(state, attacker)} is attacking`,
      }),
    ),
    row,
    el('div.panel__note', {
      text: 'Your attacker gives out its damage in this order, enough to kill each one before '
        + 'moving on. Tap the creature you most want dead.',
    }),
    el('div.panel__buttons', {}, confirm),
  );
}

/* ------------------------------------------------------------------ prompts */

/**
 * Everything the session may put in front of the player.
 *
 * Injected into the session the same way `TableView` is, so the session decides *when*
 * a question is asked and this file decides what it looks like — and neither one has
 * to import the other.
 */
export interface PromptView {
  /** The opening hand. `onKeep` carries the cards going to the bottom, London style. */
  mulligan(
    state: GameState, player: PlayerId,
    onKeep: (toBottom: CardId[]) => void, onMulligan: () => void,
  ): void;
  /** The cards on `state.pendingScry`, top or bottom. */
  scry(state: GameState, onDecide: (toBottom: CardId[]) => void): void;
  /** The damage assignment order for one blocked attacker. */
  blockerOrder(state: GameState, attacker: CardId, onConfirm: (order: CardId[]) => void): void;
  /** One card, as large as the screen allows, with whatever it affords. */
  read(state: GameState, card: CardId, actions?: CardAction[]): void;
  /** The real lands, each one the engine will let you tap. */
  lands(state: GameState, player: PlayerId, onTap: (card: CardId) => void): void;
  /** Repaint whatever is open against fresh state. A no-op for a snapshot. */
  refresh(state: GameState): void;
  close(): void;
}

export function createPrompts(host: HTMLElement): PromptView {
  return {
    mulligan(state, player, onKeep, onMulligan) {
      open(host, mulliganPanel(host, state, player, onKeep, onMulligan), 'Your opening hand', 'never');
    },
    scry(state, onDecide) {
      open(host, scryPanel(host, state, onDecide), 'Scry: top or bottom', 'never');
    },
    blockerOrder(state, attacker, onConfirm) {
      open(host, blockerOrderPanel(host, state, attacker, onConfirm), 'Damage assignment order', 'never');
    },
    read(state, card, actions = []) {
      showCard(host, state, card, actions);
    },
    lands(state, player, onTap) {
      const { body, paint, label } = landsPanel(host, state, player, onTap);
      open(host, body, label, 'backdrop');
      repaint = paint;
    },
    refresh(state) {
      repaint?.(state);
    },
    close,
  };
}

export function closeOverlay(): void {
  closeReader();
  close();
}

/**
 * Wired once per match; the session raises the event rather than importing the overlay.
 * Returns a disposer, because the host it captures dies with the table it belongs to.
 */
export function listenForZoom(host: HTMLElement): () => void {
  const onZoom = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ card: CardId; state: GameState }>).detail;
    showCard(host, detail.state, detail.card);
  };
  window.addEventListener('emteegee:zoom', onZoom);
  return () => window.removeEventListener('emteegee:zoom', onZoom);
}

export { clear };
