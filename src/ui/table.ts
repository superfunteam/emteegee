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
import { el, clear } from './dom';

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

const PHASE_LABEL: Partial<Record<string, string>> = {
  untap: 'un', upkeep: 'up', draw: 'dr', main1: 'm1',
  declareAttackers: 'cb', main2: 'm2', end: 'end',
};

/** The phases the rail shows. The rest are real but not worth a slot. */
const RAIL_PHASES = ['untap', 'upkeep', 'draw', 'main1', 'declareAttackers', 'main2', 'end'] as const;

export interface TableCallbacks {
  onTileTap(card: CardId): void;
  onHandTap(card: CardId): void;
  onManaTap(player: PlayerId): void;
  onZoneTap(zone: 'graveyard' | 'exile', player: PlayerId): void;
  onAct(): void;
}

export interface TableView {
  root: HTMLElement;
  patch(state: GameState, ui: UiState): void;
  tileFor(card: CardId): HTMLElement | undefined;
  floaty(text: string, kind: 'damage' | 'gain', anchor: 'you' | 'opponent'): void;
  ribbon(text: string | null): void;
}

/** Presentation-only state: what the player has picked up but not yet committed. */
export interface UiState {
  you: PlayerId;
  selected: Set<CardId>;
  targetable: Set<CardId>;
  blockingPairs: Map<CardId, CardId>;
  actLabel: string;
  actEnabled: boolean;
  hint: string | null;
  speech: string | null;
}

export function createTable(callbacks: TableCallbacks): TableView {
  const oppRail = el('div.rail');
  const oppMana = el('div.mana');
  const oppBoard = el('div.board');
  const mid = el('div.mid');
  const youBoard = el('div.board');
  const youMana = el('div.mana.mana--you');
  const youRail = el('div.rail.rail--you');
  const hand = el('div.hand');
  const backs = el('div.hand__backs');

  const act = el<HTMLButtonElement>('button.act', { type: 'button' });
  act.addEventListener('click', () => callbacks.onAct());

  const root = el('div.table', { role: 'application', 'aria-label': 'Magic game table' },
    oppRail, backs, oppMana, oppBoard, mid, youBoard, youMana, youRail, hand, act);

  const tiles = new Map<CardId, HTMLElement>();
  const handCards = new Map<CardId, HTMLElement>();
  let ribbonNode: HTMLElement | null = null;
  let hintNode: HTMLElement | null = null;

  function patch(state: GameState, ui: UiState): void {
    const them = opponentOf(ui.you);
    const actions = legalActions(state);

    patchRail(oppRail, state, them, false);
    patchRail(youRail, state, ui.you, true);
    patchMana(oppMana, state, them, false, callbacks);
    patchMana(youMana, state, ui.you, true, callbacks);
    patchBoard(oppBoard, state, them, ui, tiles, callbacks);
    patchBoard(youBoard, state, ui.you, ui, tiles, callbacks);
    patchMid(mid, state, ui.you, callbacks);
    patchHand(hand, state, ui, handCards, actions, callbacks);
    patchBacks(backs, state, them);

    act.textContent = ui.actLabel;
    act.disabled = !ui.actEnabled;
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

  return {
    root,
    patch,
    tileFor: card => tiles.get(card),
    ribbon: setRibbon,
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

function patchRail(node: HTMLElement, state: GameState, player: PlayerId, isYou: boolean): void {
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
  life.setAttribute('aria-label', `${isYou ? 'Your' : "The Magician's"} life total: ${p.life}`);

  node.querySelector('.js-hand')!.textContent = String(p.hand.length);
  node.querySelector('.js-lib')!.textContent = String(p.library.length);
  node.querySelector('.js-status')!.textContent =
    state.winner !== null ? '' : active ? (isYou ? 'your turn' : 'thinking…') : '';
}

/* ------------------------------------------------------------------- mana */

function patchMana(
  node: HTMLElement, state: GameState, player: PlayerId, isYou: boolean, callbacks: TableCallbacks,
): void {
  const lands = cardsIn(state, player, 'battlefield').filter(id => def(state, id).cardTypes.includes('land'));
  const pool = availableMana(state, player);

  clear(node);
  node.append(el('span.mana__label', { 'aria-hidden': 'true', text: 'mana' }));

  // One gem per land, spent gems drained rather than removed, so the player can see
  // both what they have and what they have used this turn.
  const gems: Array<{ color: Color | 'C'; spent: boolean }> = [];
  for (const id of lands) {
    const produces = def(state, id).producesMana?.[0] ?? 'C';
    gems.push({ color: produces, spent: inst(state, id).tapped });
  }
  gems.sort((a, b) => Number(a.spent) - Number(b.spent));

  const available = Object.values(pool).reduce<number>((n, v) => n + (v ?? 0), 0);
  for (const gem of gems) {
    const dot = el('span.gem');
    dot.classList.add(`gem--${gem.color.toLowerCase()}`);
    if (gem.spent) dot.classList.add('gem--spent');
    node.append(dot);
  }

  node.setAttribute('aria-label',
    `${isYou ? 'Your' : "The Magician's"} mana: ${available} available of ${lands.length} lands`);

  const button = el('button.mana__lands', { type: 'button', text: `${lands.length} lands` });
  if (isYou) button.addEventListener('click', () => callbacks.onManaTap(player));
  node.append(button);
}

/* ------------------------------------------------------------ battlefield */

function patchBoard(
  node: HTMLElement, state: GameState, player: PlayerId, ui: UiState,
  tiles: Map<CardId, HTMLElement>, callbacks: TableCallbacks,
): void {
  const creatures = cardsIn(state, player, 'battlefield').filter(id => isCreature(state, id));

  node.classList.toggle('board--dense', creatures.length >= 5);
  node.setAttribute('aria-label',
    `${player === ui.you ? 'Your' : "The Magician's"} battlefield, ${creatures.length} creatures`);

  let row = node.querySelector<HTMLElement>('.board__row');
  if (!row) { row = el('div.board__row'); node.append(row); }

  const present = new Set(creatures);
  for (const [id, tile] of tiles) {
    if (!present.has(id) && tile.parentElement === row) {
      // Let the death animation play before the node leaves the tree.
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
      tiles.set(id, tile);
    }
    if (row!.children[index] !== tile) row!.insertBefore(tile, row!.children[index] ?? null);
    updateTile(tile, state, id, ui);
  });
}

function buildTile(id: CardId, callbacks: TableCallbacks): HTMLElement {
  const tile = el('button.tile', { type: 'button', dataCard: id },
    el('img.tile__art', { alt: '', loading: 'lazy' }),
    el('div.tile__keywords', { 'aria-hidden': 'true' }),
    el('div.tile__pt', { 'aria-hidden': 'true' }),
    el('div.tile__name'),
  );
  tile.addEventListener('click', () => callbacks.onTileTap(id));
  return tile;
}

function updateTile(tile: HTMLElement, state: GameState, id: CardId, ui: UiState): void {
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

  tile.classList.toggle('tile--tapped', card.tapped);
  tile.classList.toggle('tile--attacking', card.attacking);
  tile.classList.toggle('tile--blocking', card.blocking !== undefined);
  tile.classList.toggle('tile--selected', ui.selected.has(id));
  tile.classList.toggle('tile--targetable', ui.targetable.has(id));
  tile.classList.toggle('tile--sick',
    card.summonedThisTurn && !hasKeyword(state, id, 'haste') && card.controller === ui.you);

  const counters = card.counters['+1/+1'] - card.counters['-1/-1'];
  let badge = tile.querySelector<HTMLElement>('.tile__counters');
  if (counters > 0) {
    if (!badge) { badge = el('div.tile__counters'); tile.append(badge); }
    badge.textContent = `+${counters}`;
  } else badge?.remove();

  tile.setAttribute('aria-label', describeCreature(state, id, ui));
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

    phases = el('div.phases', { role: 'status', 'aria-label': 'Turn phase' });
    for (const phase of RAIL_PHASES) {
      phases.append(el('b', { dataPhase: phase, text: PHASE_LABEL[phase] ?? phase }));
    }
    node.append(el('div.yard', {}, gy), phases, el('div.yard', {}, ex));
  }

  // Combat's four steps all light the one combat slot, so the rail stays legible.
  const index = PHASE_ORDER.indexOf(state.phase);
  const combatStart = PHASE_ORDER.indexOf('beginCombat');
  const combatEnd = PHASE_ORDER.indexOf('endCombat');
  const shown = index >= combatStart && index <= combatEnd ? 'declareAttackers' : state.phase;

  for (const b of phases.querySelectorAll<HTMLElement>('b')) {
    b.classList.toggle('on', b.dataset.phase === shown);
  }

  node.querySelector('.yard button')!.textContent = `GY ${state.players[you].graveyard.length}`;
  node.querySelectorAll('.yard button')[1]!.textContent = `EX ${state.players[you].exile.length}`;
}

/* ------------------------------------------------------------------- hand */

function patchHand(
  node: HTMLElement, state: GameState, ui: UiState,
  cards: Map<CardId, HTMLElement>, actions: Action[], callbacks: TableCallbacks,
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
    if (!present.has(id)) { card.remove(); cards.delete(id); }
  }

  inHand.forEach((id, index) => {
    let card = cards.get(id);
    if (!card) {
      const d = def(state, id);
      card = el('button.hand__card', { type: 'button', dataCard: id },
        el('img', { src: d.image, alt: '' }));
      card.addEventListener('click', () => callbacks.onHandTap(id));
      cards.set(id, card);
    }
    if (node.children[index + 1] !== card) node.insertBefore(card, node.children[index + 1] ?? null);

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
