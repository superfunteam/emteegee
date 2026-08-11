/**
 * The game state: construction, zones, and the pure lookups everything else
 * builds on.
 *
 * Three rules hold everywhere in this file, and every other engine module
 * inherits them:
 *
 * 1. **Nothing here is impure.** No DOM, no clock, no `Math.random`. The only
 *    randomness is `makeRng(state.rngSeed)` from `./rng`.
 * 2. **A `GameState` handed in is never touched.** Anything that changes state
 *    clones first via `cloneState`, which copies every nested container. A
 *    shallow copy that shares a zone array is the bug this file exists to
 *    prevent: it passes a test today and corrupts a bot search tomorrow.
 * 3. **Lookups throw rather than return `undefined`.** Reaching a missing card
 *    is an engine bug, and spec §13 says engine bugs are loud.
 *
 * `CardDef`s are the one thing shared by reference across clones. The contract
 * in `types.ts` declares them immutable, and copying ~250 of them per clone
 * would make the bot search pointlessly slow.
 */

import type {
  CardDef,
  CardId,
  CardInstance,
  CardType,
  Color,
  GameState,
  Keyword,
  ManaCost,
  OracleId,
  PlayerId,
  PlayerState,
  StackObject,
  StaticAbility,
  TargetFilter,
  Zone,
} from './types';
import { STARTING_HAND, STARTING_LIFE } from './types';
import { makeRng, shuffle } from './rng';

/** Every mana symbol that can appear in a cost or a pool. */
const MANA_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
/** The five colors, in a fixed order so payment is deterministic. */
const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** Zones that are a per-player array. The stack is shared and holds objects, not ids. */
type PlayerZone = Exclude<Zone, 'stack'>;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function emptyPlayer(id: PlayerId): PlayerState {
  return {
    id,
    life: STARTING_LIFE,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    landPlayedThisTurn: false,
    manaPool: {},
    mulligansTaken: 0,
    drewFromEmpty: false,
  };
}

function makeInstance(id: CardId, oracleId: OracleId, owner: PlayerId, zone: Zone): CardInstance {
  return {
    id,
    oracleId,
    controller: owner,
    owner,
    zone,
    tapped: false,
    summonedThisTurn: false,
    damage: 0,
    counters: { '+1/+1': 0, '-1/-1': 0 },
    tempPump: { power: 0, toughness: 0 },
    tempKeywords: [],
    isToken: false,
    attacking: false,
    blockedBy: [],
  };
}

/**
 * Build a fresh game: shuffle both decks, deal seven each, and stop at the
 * first main phase of turn one.
 *
 * Both libraries are shuffled from one `makeRng(seed)` stream, so the same seed
 * reproduces the same game exactly while the two players still get different
 * orders out of identical decklists.
 *
 * Player 0 is the human and is always on the play (spec §3), which is why the
 * game opens in `main1` with 7 cards each: their turn-one draw step has already
 * gone by. The Magician draws normally on their own first turn and so ends up
 * with the extra card.
 *
 * The top of a library is index 0.
 */
export function createGame(
  defs: Record<OracleId, CardDef>,
  deckA: OracleId[],
  deckB: OracleId[],
  seed: number,
): GameState {
  const rng = makeRng(seed);
  const cards: Record<CardId, CardInstance> = {};
  let nextId = 0;

  const deal = (deck: OracleId[], owner: PlayerId): PlayerState => {
    const player = emptyPlayer(owner);
    for (const oracleId of shuffle(deck, rng)) {
      if (!defs[oracleId]) throw new Error(`createGame: no card definition for "${oracleId}"`);
      const id = `${oracleId}#${nextId}`;
      nextId += 1;
      cards[id] = makeInstance(id, oracleId, owner, 'library');
      player.library.push(id);
    }
    player.hand = player.library.splice(0, STARTING_HAND);
    for (const id of player.hand) cards[id]!.zone = 'hand';
    return player;
  };

  return {
    cards,
    defs,
    players: [deal(deckA, 0), deal(deckB, 1)],
    active: 0,
    priority: 0,
    turn: 1,
    phase: 'main1',
    stack: [],
    winner: null,
    rngSeed: seed,
    nextId,
    resolvingTrigger: false,
    pendingScry: null,
  };
}

/**
 * Add a card to the game and put it in a zone.
 *
 * A permanent lands on its controller's battlefield; anything else goes to that
 * player's own zone. `zone: 'stack'` registers the instance without touching any
 * array, because the stack holds `StackObject`s and `rules.ts` owns those.
 *
 * Something arriving on the battlefield is summoning sick, which is what
 * `hasKeyword(..., 'haste')` is checked against at declare-attackers.
 *
 * A def is not required: a token carries its characteristics on
 * `CardInstance.tokenSpec`, and every characteristic helper here reads that when
 * no def is registered.
 */
export function newInstance(
  state: GameState,
  oracleId: OracleId,
  controller: PlayerId,
  zone: Zone,
): { state: GameState; id: CardId } {
  const next = cloneState(state);
  const id = `${oracleId}#${next.nextId}`;
  next.nextId += 1;

  const card = makeInstance(id, oracleId, controller, zone);
  card.summonedThisTurn = zone === 'battlefield';
  next.cards[id] = card;
  if (zone !== 'stack') zoneArray(next.players[controller], zone).push(id);

  return { state: next, id };
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

function cloneInstance(card: CardInstance): CardInstance {
  return {
    ...card,
    counters: { ...card.counters },
    tempPump: { ...card.tempPump },
    tempKeywords: [...card.tempKeywords],
    blockedBy: [...card.blockedBy],
    tokenSpec: card.tokenSpec
      ? {
          ...card.tokenSpec,
          colors: [...card.tokenSpec.colors],
          subtypes: [...card.tokenSpec.subtypes],
          keywords: [...card.tokenSpec.keywords],
        }
      : undefined,
  };
}

function clonePlayer(player: PlayerState): PlayerState {
  return {
    ...player,
    library: [...player.library],
    hand: [...player.hand],
    battlefield: [...player.battlefield],
    graveyard: [...player.graveyard],
    exile: [...player.exile],
    manaPool: { ...player.manaPool },
  };
}

function cloneStackObject(object: StackObject): StackObject {
  return {
    ...object,
    effects: [...object.effects],
    targets: Array.isArray(object.targets) ? [...object.targets] : object.targets,
  };
}

/**
 * A structural copy: every container a mutator could reach is new.
 *
 * `defs` is deliberately shared — the contract says definitions are never
 * mutated, and deep-copying the whole card pool on every clone would dominate
 * the bot's search cost.
 */
export function cloneState(state: GameState): GameState {
  const cards: Record<CardId, CardInstance> = {};
  for (const id of Object.keys(state.cards)) cards[id] = cloneInstance(state.cards[id]!);

  return {
    cards,
    defs: state.defs,
    players: [clonePlayer(state.players[0]), clonePlayer(state.players[1])],
    active: state.active,
    priority: state.priority,
    turn: state.turn,
    phase: state.phase,
    stack: state.stack.map(cloneStackObject),
    winner: state.winner,
    rngSeed: state.rngSeed,
    nextId: state.nextId,
    resolvingTrigger: state.resolvingTrigger,
    pendingScry: state.pendingScry
      ? { player: state.pendingScry.player, cards: [...state.pendingScry.cards] }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The instance with this id. Throws if there is none — that is always a bug. */
export function inst(state: GameState, id: CardId): CardInstance {
  const card = state.cards[id];
  if (!card) throw new Error(`inst: no card instance "${id}"`);
  return card;
}

/**
 * The definition behind an instance. Throws when none is registered, which for a
 * token is expected — read its characteristics through `powerOf` / `hasKeyword`
 * / `isCreature` instead, all of which fall back to `tokenSpec`.
 */
export function def(state: GameState, id: CardId): CardDef {
  const card = inst(state, id);
  const found = state.defs[card.oracleId];
  if (!found) throw new Error(`def: no card definition for "${card.oracleId}" (instance "${id}")`);
  return found;
}

function zoneArray(player: PlayerState, zone: PlayerZone): CardId[] {
  switch (zone) {
    case 'library':
      return player.library;
    case 'hand':
      return player.hand;
    case 'battlefield':
      return player.battlefield;
    case 'graveyard':
      return player.graveyard;
    case 'exile':
      return player.exile;
  }
}

/**
 * The contents of one player's zone, as a copy — callers get a list to read, not
 * a handle on the state.
 *
 * `'stack'` reports the sources of that player's stack objects, bottom to top.
 */
export function cardsIn(state: GameState, player: PlayerId, zone: Zone): CardId[] {
  if (zone === 'stack') {
    return state.stack.filter((object) => object.controller === player).map((object) => object.source);
  }
  return [...zoneArray(state.players[player], zone)];
}

/** The other player. */
export function opponentOf(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Zone changes
// ---------------------------------------------------------------------------

function resetOnLeavingBattlefield(card: CardInstance): void {
  card.tapped = false;
  card.summonedThisTurn = false;
  card.damage = 0;
  card.counters = { '+1/+1': 0, '-1/-1': 0 };
  card.tempPump = { power: 0, toughness: 0 };
  card.tempKeywords = [];
  card.attacking = false;
  card.blocking = undefined;
  card.blockedBy = [];
  card.attachedTo = undefined;
}

/**
 * Move a card between zones.
 *
 * Removes it from the source zone array, appends it to the destination, and
 * updates `instance.zone`. A permanent leaving the battlefield becomes a new
 * object: damage, counters, temporary pump and keywords, attachment, and all
 * combat state are dropped. A token that leaves the battlefield ceases to exist
 * and is deleted from `state.cards` along with every reference to it.
 *
 * Moving to or from `'stack'` only changes `instance.zone`; the `StackObject`
 * itself is `rules.ts`'s business.
 *
 * Throws when the card is not actually in the zone the caller named — a wrong
 * `from` is a bug worth surfacing immediately.
 */
export function move(state: GameState, card: CardId, from: Zone, to: Zone): GameState {
  const next = cloneState(state);
  const instance = next.cards[card];
  if (!instance) throw new Error(`move: no card instance "${card}"`);

  if (from !== 'stack') {
    let removed = false;
    for (const player of next.players) {
      const zone = zoneArray(player, from);
      const at = zone.indexOf(card);
      if (at >= 0) {
        zone.splice(at, 1);
        removed = true;
        break;
      }
    }
    if (!removed) throw new Error(`move: "${card}" is not in the ${from} zone`);
  }

  const leavingBattlefield = from === 'battlefield' && to !== 'battlefield';
  if (leavingBattlefield) resetOnLeavingBattlefield(instance);

  if (leavingBattlefield && instance.isToken) {
    delete next.cards[card];
    for (const other of Object.values(next.cards)) {
      if (other.blocking === card) other.blocking = undefined;
      if (other.attachedTo === card) other.attachedTo = undefined;
      if (other.blockedBy.includes(card)) other.blockedBy = other.blockedBy.filter((id) => id !== card);
    }
    return next;
  }

  instance.zone = to;
  if (to !== 'stack') {
    const owner = to === 'battlefield' ? instance.controller : instance.owner;
    zoneArray(next.players[owner], to).push(card);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Characteristics
// ---------------------------------------------------------------------------

interface BaseChars {
  power: number | undefined;
  toughness: number | undefined;
  cardTypes: readonly CardType[];
  subtypes: readonly string[];
  colors: readonly Color[];
  keywords: readonly Keyword[];
  statics: readonly StaticAbility[];
}

const TOKEN_TYPES: readonly CardType[] = ['creature'];
const NO_STATICS: readonly StaticAbility[] = [];

/**
 * Printed characteristics, before anything on the table modifies them.
 *
 * A def wins when one is registered; otherwise a token falls back to its
 * `tokenSpec`, so `createToken` never has to invent a `CardDef` and mutate the
 * shared `defs` map to do it.
 */
function baseChars(state: GameState, id: CardId): BaseChars {
  const card = inst(state, id);
  const found = state.defs[card.oracleId];
  if (found) {
    return {
      power: found.power,
      toughness: found.toughness,
      cardTypes: found.cardTypes,
      subtypes: found.subtypes,
      colors: found.colors,
      keywords: found.keywords,
      statics: found.statics,
    };
  }
  if (card.tokenSpec) {
    return {
      power: card.tokenSpec.power,
      toughness: card.tokenSpec.toughness,
      cardTypes: TOKEN_TYPES,
      subtypes: card.tokenSpec.subtypes,
      colors: card.tokenSpec.colors,
      keywords: card.tokenSpec.keywords,
      statics: NO_STATICS,
    };
  }
  throw new Error(`def: no card definition for "${card.oracleId}" (instance "${id}")`);
}

/** Every permanent on either battlefield, in a stable order. */
function permanents(state: GameState): CardInstance[] {
  const out: CardInstance[] = [];
  for (const player of state.players) {
    for (const id of player.battlefield) {
      const card = state.cards[id];
      if (card) out.push(card);
    }
  }
  return out;
}

/** What the auras attached to this card add to it. */
function auraBonus(state: GameState, id: CardId): { power: number; toughness: number } {
  let power = 0;
  let toughness = 0;
  for (const aura of permanents(state)) {
    if (aura.attachedTo !== id) continue;
    for (const ability of baseChars(state, aura.id).statics) {
      if (ability.kind !== 'aura') continue;
      power += ability.power;
      toughness += ability.toughness;
    }
  }
  return { power, toughness };
}

/**
 * Power and toughness without any `staticPump` contribution.
 *
 * Filters may test `minPower` / `maxPower`, and a lord whose filter reads power
 * would recurse into itself forever if that read counted lord effects. Breaking
 * the cycle here means "creatures with power 2 or less" measures the creature
 * before the lords, which is the reading the pool's cards want anyway.
 */
function rawChars(state: GameState, id: CardId): { power: number; toughness: number } {
  const card = inst(state, id);
  const base = baseChars(state, id);
  const aura = auraBonus(state, id);
  const counters = card.counters['+1/+1'] - card.counters['-1/-1'];
  return {
    power: (base.power ?? 0) + counters + card.tempPump.power + aura.power,
    toughness: (base.toughness ?? 0) + counters + card.tempPump.toughness + aura.toughness,
  };
}

/**
 * Does this card satisfy a filter, as written from `source`'s point of view?
 *
 * `controller: 'you'` means the controller of whatever wrote the filter, not
 * player 0. Only the fields the filter sets are tested.
 *
 * Exported for `effects.ts`, which needs it to sweep the battlefields for a mass
 * effect. This is the *base characteristics* reading — it deliberately does not
 * consult `powerOf`, because a lord whose own filter tests `minPower` would then
 * recurse into itself.
 */
export function matchesFilter(
  state: GameState,
  id: CardId,
  filter: TargetFilter,
  sourceController: PlayerId,
): boolean {
  const card = state.cards[id];
  if (!card) return false;

  if (filter.zone !== undefined && card.zone !== filter.zone) return false;
  if (filter.controller === 'you' && card.controller !== sourceController) return false;
  if (filter.controller === 'opponent' && card.controller !== opponentOf(sourceController)) return false;

  const base = baseChars(state, id);
  if (filter.cardTypes && !filter.cardTypes.some((t) => base.cardTypes.includes(t))) return false;
  if (filter.subtypes && !filter.subtypes.some((t) => base.subtypes.includes(t))) return false;
  if (filter.colors && !filter.colors.some((c) => base.colors.includes(c))) return false;

  // Negated constraints are "none of these", not "not all of these": a black-red
  // creature fails `notColors: ['B']`, and a colorless one passes it.
  if (filter.notColors && filter.notColors.some((c) => base.colors.includes(c))) return false;
  if (filter.notCardTypes && filter.notCardTypes.some((t) => base.cardTypes.includes(t))) return false;

  if (filter.minPower !== undefined || filter.maxPower !== undefined) {
    const power = rawChars(state, id).power;
    if (filter.minPower !== undefined && power < filter.minPower) return false;
    if (filter.maxPower !== undefined && power > filter.maxPower) return false;
  }

  if (filter.tapped !== undefined && card.tapped !== filter.tapped) return false;
  if (filter.attacking !== undefined && card.attacking !== filter.attacking) return false;
  if (filter.blocking !== undefined && (card.blocking !== undefined) !== filter.blocking) return false;
  return true;
}

type StaticPump = Extract<StaticAbility, { kind: 'staticPump' }>;

/**
 * Every `staticPump` on the table that applies to this card.
 *
 * A lord reaches only permanents on the battlefield, it skips itself when it says
 * "other", and its filter is read from *its* controller's point of view — which
 * is what makes `controller: 'you'` on a lord mean "mine" rather than "player
 * 0"'s, and what keeps a Goblin lord out of the opponent's Goblins.
 *
 * Both halves of a lord are decided here, so the keywords it grants land on
 * exactly the creatures its +N/+N does. A lord whose pump applied to a creature
 * its haste did not would be a lord that lets a Goblin attack at the wrong size,
 * or refuses an attack the printed card allows.
 */
function staticPumpsOn(state: GameState, id: CardId): StaticPump[] {
  const out: StaticPump[] = [];
  if (inst(state, id).zone !== 'battlefield') return out;

  for (const source of permanents(state)) {
    for (const ability of baseChars(state, source.id).statics) {
      if (ability.kind !== 'staticPump') continue;
      if (source.id === id && ability.excludeSelf) continue;
      if (!matchesFilter(state, id, ability.filter, source.controller)) continue;
      out.push(ability);
    }
  }
  return out;
}

/** Everything the lords on the table add to this card. */
function staticPumpFor(state: GameState, id: CardId): { power: number; toughness: number } {
  let power = 0;
  let toughness = 0;
  for (const ability of staticPumpsOn(state, id)) {
    power += ability.power;
    toughness += ability.toughness;
  }
  return { power, toughness };
}

/** May this creature be declared as a blocker at all, before any attacker is named? */
export function cantBlock(state: GameState, card: CardId): boolean {
  return baseChars(state, card).statics.some((ability) => ability.kind === 'cantBlock');
}

/**
 * Current power: printed, plus `+1/+1` counters, minus `-1/-1` counters, plus
 * temporary pump, plus attached auras, plus every `staticPump` whose filter it
 * matches. A permanent with no printed power — a land, an instant — is 0.
 */
export function powerOf(state: GameState, card: CardId): number {
  if (baseChars(state, card).power === undefined) return 0;
  return rawChars(state, card).power + staticPumpFor(state, card).power;
}

/** Current toughness, by the same arithmetic as {@link powerOf}. */
export function toughnessOf(state: GameState, card: CardId): number {
  if (baseChars(state, card).toughness === undefined) return 0;
  return rawChars(state, card).toughness + staticPumpFor(state, card).toughness;
}

/**
 * Does this card have this keyword right now?
 *
 * Five sources count: printed keywords, a `keyword` static on the card itself,
 * keywords granted until end of turn, keywords from an attached aura, and
 * keywords a lord grants alongside its pump ("Other Goblins you control get
 * +1/+1 and have haste"). Keywords are lowercase and compared exactly —
 * `'first strike'`, never `'First Strike'`.
 *
 * The lord half goes through {@link staticPumpsOn}, the same filter and
 * `excludeSelf` reasoning that decides the +N/+N, so the two can never disagree
 * about which creatures a lord is talking about.
 */
export function hasKeyword(state: GameState, card: CardId, kw: Keyword): boolean {
  const instance = inst(state, card);
  const base = baseChars(state, card);

  if (base.keywords.includes(kw)) return true;
  if (instance.tempKeywords.includes(kw)) return true;
  for (const ability of base.statics) {
    if (ability.kind === 'keyword' && ability.keyword === kw) return true;
  }
  for (const aura of permanents(state)) {
    if (aura.attachedTo !== card) continue;
    for (const ability of baseChars(state, aura.id).statics) {
      if (ability.kind === 'aura' && ability.keywords.includes(kw)) return true;
    }
  }
  for (const ability of staticPumpsOn(state, card)) {
    if (ability.keywords?.includes(kw)) return true;
  }
  return false;
}

/** Is this card a creature? Tokens are, whether or not a def was registered. */
export function isCreature(state: GameState, card: CardId): boolean {
  return baseChars(state, card).cardTypes.includes('creature');
}

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------

/**
 * What this player could produce right now: one mana per untapped land, plus
 * whatever is already floating in their pool.
 *
 * This is a report, not a payment plan. A land that could produce more than one
 * color is counted under each of them, so the total is an upper bound — ask
 * {@link canPay} whether a specific cost is actually payable.
 */
export function availableMana(state: GameState, player: PlayerId): Partial<Record<Color | 'C', number>> {
  const out: Partial<Record<Color | 'C', number>> = {};
  const add = (key: Color | 'C', n: number): void => {
    if (n > 0) out[key] = (out[key] ?? 0) + n;
  };

  const pool = state.players[player].manaPool;
  for (const key of MANA_KEYS) add(key, pool[key] ?? 0);

  for (const id of state.players[player].battlefield) {
    const card = state.cards[id];
    if (!card || card.tapped) continue;
    const produces = state.defs[card.oracleId]?.producesMana;
    if (!produces) continue;
    for (const color of produces) add(color, 1);
  }
  return out;
}

type ManaSource =
  | { kind: 'pool'; key: Color | 'C'; colors: readonly Color[] }
  | { kind: 'land'; id: CardId; colors: readonly Color[] };

function manaSources(state: GameState, player: PlayerId): ManaSource[] {
  const out: ManaSource[] = [];

  const pool = state.players[player].manaPool;
  for (const key of MANA_KEYS) {
    const count = pool[key] ?? 0;
    for (let i = 0; i < count; i++) out.push({ kind: 'pool', key, colors: key === 'C' ? [] : [key] });
  }

  for (const id of state.players[player].battlefield) {
    const card = state.cards[id];
    if (!card || card.tapped) continue;
    const produces = state.defs[card.oracleId]?.producesMana;
    if (!produces || produces.length === 0) continue;
    out.push({ kind: 'land', id, colors: produces });
  }
  return out;
}

/**
 * Work out which sources would pay a cost, or `null` if none can.
 *
 * Colored pips are assigned first, because a colored requirement is the only
 * thing a source can fail to satisfy; generic then takes whatever is left, which
 * is what makes `{1}{G}` payable by a Forest and a Plains. Among the candidates
 * for a pip, floating mana is spent before a land is tapped, and the least
 * flexible source is spent before a more flexible one, so a dual is kept back
 * for the pip that needs it.
 */
function solvePayment(state: GameState, player: PlayerId, cost: ManaCost): ManaSource[] | null {
  const sources = manaSources(state, player);
  const spent = new Set<number>();

  const take = (want: Color | null): boolean => {
    let choice = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < sources.length; i++) {
      if (spent.has(i)) continue;
      const source = sources[i]!;
      if (want !== null && !source.colors.includes(want)) continue;
      const score = (source.kind === 'pool' ? 0 : 100) + source.colors.length;
      if (score < bestScore) {
        bestScore = score;
        choice = i;
      }
    }
    if (choice < 0) return false;
    spent.add(choice);
    return true;
  };

  for (const color of COLORS) {
    for (let i = 0; i < (cost[color] ?? 0); i++) {
      if (!take(color)) return null;
    }
  }
  for (let i = 0; i < (cost.C ?? 0); i++) {
    if (!take(null)) return null;
  }

  return [...spent].map((i) => sources[i]!);
}

/**
 * Can this player pay this cost from untapped lands and floating mana?
 *
 * `C` in a cost is generic and any color pays it, so a Forest and a Plains cover
 * `{1}{G}`. Colorless floating mana pays generic only, never a colored pip.
 */
export function canPay(state: GameState, player: PlayerId, cost: ManaCost): boolean {
  return solvePayment(state, player, cost) !== null;
}

/**
 * Pay a cost: drain the floating mana and tap the lands the payment used.
 *
 * Throws when the cost cannot be paid — callers check {@link canPay} (or, in
 * practice, `legalActions`) first, so reaching this is a bug. No mana is ever
 * left floating: each source produces exactly the one symbol it was spent for.
 */
export function payMana(state: GameState, player: PlayerId, cost: ManaCost): GameState {
  const plan = solvePayment(state, player, cost);
  if (!plan) {
    throw new Error(`payMana: player ${player} cannot pay ${JSON.stringify(cost)}`);
  }

  const next = cloneState(state);
  const pool = next.players[player].manaPool;
  for (const source of plan) {
    if (source.kind === 'pool') {
      const held = pool[source.key] ?? 0;
      if (held > 1) pool[source.key] = held - 1;
      else delete pool[source.key];
    } else {
      next.cards[source.id]!.tapped = true;
    }
  }
  return next;
}
