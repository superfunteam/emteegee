/**
 * The interpreter for the closed effect vocabulary.
 *
 * A card's behavior is data — a list of `Effect` descriptors — and this file is
 * the only thing that knows what those descriptors mean. Adding a card never
 * touches this file; adding a *mechanic* means extending `Effect` in `types.ts`,
 * and the exhaustive switch below then fails to compile until it is handled.
 *
 * Four rules hold throughout, and each one is load-bearing:
 *
 * 1. **Pure.** No DOM, no clock, no `Math.random`. Every handler takes a
 *    `GameState` and returns `{ state, events }` — never a `ReduceResult` in.
 * 2. **The input state is never touched.** Handlers clone through `cloneState`
 *    (or through `move` / `newInstance`, which clone themselves) and mutate only
 *    the copy they own. `defs` is shared by reference across clones, so
 *    `createToken` replaces the map rather than writing into it.
 * 3. **Damage never removes a creature.** It marks `instance.damage` and stops.
 *    State-based actions in `rules.ts` do the killing, so a creature that is
 *    lethally damaged and then pumped in response survives — which is the whole
 *    point of separating the two.
 * 4. **A trigger may not enqueue a trigger.** When `state.resolvingTrigger` is
 *    set, a triggered ability still records its `TRIGGER` event but does not go
 *    on the stack. This is the structural guard against loops (spec §5); it
 *    lives in `triggers.ts`, which every module that fires a trigger shares.
 *
 * Targeting legality is not decided here. `actions.ts` owns it, and this file
 * trusts the `TargetSelection` it is handed: a filtered effect with no selection
 * simply does nothing rather than inventing its own idea of a legal target.
 */

import type {
  CardDef,
  CardId,
  Color,
  CounterKind,
  Effect,
  EffectTarget,
  GameEvent,
  GameState,
  OracleId,
  PlayerId,
  PlayerTarget,
  ReduceResult,
  TargetSelection,
  TokenSpec,
  Zone,
} from './types';
import { assertNever, isEveryTarget } from './types';
import { cloneState, isCreature, matchesFilter, move, newInstance, opponentOf } from './state';
import { fireTriggers, notifyEnteredBattlefield, triggersOfDef, type TriggerSource } from './triggers';
import {
  evCounterAdd,
  evCountered,
  evDamage,
  evDamagePlayer,
  evDie,
  evDraw,
  evLifeChange,
  evScry,
  evTap,
  evTokenCreate,
  evUntap,
  evZoneChange,
} from './events';

/**
 * Apply one effect and report what happened.
 *
 * `source` is the card the effect came from — a spell on the stack, a permanent
 * with a triggered ability, the creature whose ability was activated. It is what
 * `target: 'self'` resolves to and what every emitted event is attributed to.
 *
 * `controller` is the player the effect is written from the point of view of:
 * `player: 'you'` means them, `player: 'opponent'` means the other one.
 *
 * `targets` is what the player (or the bot) chose, already checked by
 * `actions.ts`.
 */
export function applyEffect(
  state: GameState,
  effect: Effect,
  source: CardId,
  controller: PlayerId,
  targets: TargetSelection,
): ReduceResult {
  switch (effect.kind) {
    case 'damage':
      return damage(state, effect.target, effect.amount, source, controller, targets);
    case 'destroy':
      return relocate(state, cardsFor(state, effect.target, source, targets), 'graveyard', true);
    case 'sacrifice':
      return relocate(state, cardsFor(state, effect.target, source, targets), 'graveyard', true);
    case 'exile':
      return relocate(state, cardsFor(state, effect.target, source, targets), 'exile', false);
    case 'returnToHand':
      return relocate(state, cardsFor(state, effect.target, source, targets), 'hand', false);
    case 'draw':
      return draw(state, sideOf(effect.player, controller, targets), effect.count);
    case 'discard':
      return discard(state, sideOf(effect.player, controller, targets), effect.count);
    case 'gainLife':
      return gainLife(state, sideOf(effect.player, controller, targets), effect.amount);
    case 'loseLife':
      return loseLife(state, sideOf(effect.player, controller, targets), effect.amount);
    case 'pump':
      return pump(state, effect, cardsFor(state, effect.target, source, targets));
    case 'grantKeyword':
      return grantKeyword(state, effect, cardsFor(state, effect.target, source, targets));
    case 'tap':
      return setTapped(state, cardsFor(state, effect.target, source, targets), true);
    case 'untap':
      return setTapped(state, cardsFor(state, effect.target, source, targets), false);
    case 'addCounter':
      return addCounter(state, effect.counter, effect.count, cardsFor(state, effect.target, source, targets));
    case 'createToken':
      return createToken(state, effect.token, effect.count, controller);
    case 'scry':
      return scry(state, controller, effect.count);
    case 'addMana':
      return addMana(state, controller, effect.colors);
    case 'counterSpell':
      return counterSpell(state, source, targets);
    default:
      return assertNever(effect, 'applyEffect');
  }
}

/**
 * Apply a list of effects in order, threading the state through and
 * concatenating the events.
 *
 * Every effect sees the state the one before it produced, so `draw a card, then
 * discard a card` discards from the hand that includes the drawn card.
 */
export function applyEffects(
  state: GameState,
  effects: Effect[],
  source: CardId,
  controller: PlayerId,
  targets: TargetSelection,
): ReduceResult {
  let next = state;
  const events: GameEvent[] = [];
  for (const effect of effects) {
    const result = applyEffect(next, effect, source, controller, targets);
    next = result.state;
    events.push(...result.events);
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Resolving who and what an effect points at
// ---------------------------------------------------------------------------

/**
 * Which player an effect acts on.
 *
 * `'you'` and `'opponent'` are relative to whoever controls the effect, so one
 * card reads correctly from either side of the table. `'target'` is the caster's
 * choice and comes from the selection `actions.ts` validated — "target player
 * draws a card" is a different card from "you draw a card", and collapsing the
 * two would hand the draw to the wrong player.
 *
 * A `'target'` with no player selected falls back to the opponent, the same
 * reading {@link playerFor} gives an unselected `'player'`: every card in the
 * pool that points at a player unprompted is pointing across the table.
 */
function sideOf(who: PlayerTarget, controller: PlayerId, targets: TargetSelection): PlayerId {
  if (who === 'you') return controller;
  if (who === 'opponent') return opponentOf(controller);
  return selectedPlayer(targets) ?? opponentOf(controller);
}

/** The player a `TargetSelection` names, if it names one. */
function selectedPlayer(targets: TargetSelection): PlayerId | null {
  if (targets === 'player0') return 0;
  if (targets === 'player1') return 1;
  return null;
}

/**
 * The cards an effect applies to.
 *
 * `'self'` is the source, whatever the selection says — a creature pumping
 * itself does not care what the player tapped. `'player'` is not a card at all.
 * A `TargetFilter` — and `'any'` when the caster chose a creature — resolves to
 * exactly the selection `actions.ts` validated: this file never re-derives
 * legality, so an effect handed no selection affects nothing.
 *
 * `'any'` pointed at a player leaves nothing here, because the selection is not
 * a list of cards; {@link playerFor} picks it up instead.
 */
function cardsFor(
  state: GameState,
  target: EffectTarget,
  source: CardId,
  targets: TargetSelection,
): CardId[] {
  if (target === 'self') return state.cards[source] ? [source] : [];
  if (target === 'player') return [];

  // A mass effect has nothing to choose, so it does not consult the selection at all:
  // it sweeps both battlefields for everything the filter matches. This is the whole
  // difference between Doom Blade and Wrath of God, and writing the latter as a bare
  // filter would leave it destroying nothing while looking like it resolved.
  if (isEveryTarget(target)) {
    const controller = state.cards[source]?.controller ?? 0;
    const matches: CardId[] = [];
    for (const player of [0, 1] as const) {
      for (const id of state.players[player].battlefield) {
        if (matchesFilter(state, id, target.every, controller)) matches.push(id);
      }
    }
    return matches;
  }

  if (!Array.isArray(targets)) return [];
  return targets.filter((id) => state.cards[id] !== undefined);
}

/**
 * The player an effect points at, or `null` when it points at cards instead.
 *
 * `'player'` always names one: with nothing selected it is the opponent, which
 * is what every "deals N damage to target player" in the pool means when nobody
 * chose.
 *
 * `'any'` is Magic's "any target" and names one only when the caster actually
 * chose a face. A creature selection leaves it `null` and the damage goes to
 * {@link cardsFor} instead — the two branches of the same choice, decided by
 * which shape of `TargetSelection` came back. With no selection at all it points
 * nowhere and the effect does nothing: "any target" is a choice, and inventing
 * one here would be this file deciding legality, which `actions.ts` owns.
 */
function playerFor(target: EffectTarget, controller: PlayerId, targets: TargetSelection): PlayerId | null {
  if (target === 'any') return selectedPlayer(targets);
  if (target !== 'player') return null;
  return selectedPlayer(targets) ?? opponentOf(controller);
}

// ---------------------------------------------------------------------------
// Life
// ---------------------------------------------------------------------------

/**
 * Move a life total on a state this caller owns and report the change.
 *
 * Life is never clamped: a player at -3 is a state `rules.ts` turns into a loss
 * through state-based actions, and clamping here would hide how far past lethal
 * a swing went.
 */
function changeLife(owned: GameState, player: PlayerId, delta: number): GameEvent {
  const side = owned.players[player];
  const from = side.life;
  const to = from + delta;
  side.life = to;
  return evLifeChange(player, from, to);
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/**
 * Damage: a life loss on a player, a mark on a permanent.
 *
 * Marking is all this does. A creature with damage at or past its toughness dies
 * to a state-based action in `rules.ts`, never here — that separation is what
 * lets a pump spell save a creature in response to a burn spell.
 *
 * Lifelink is deliberately absent: `combat.ts` owns it, on damage dealt, and
 * gaining life in both places would double it.
 */
function damage(
  state: GameState,
  target: EffectTarget,
  amount: number,
  source: CardId,
  controller: PlayerId,
  targets: TargetSelection,
): ReduceResult {
  const next = cloneState(state);
  const events: GameEvent[] = [];

  const player = playerFor(target, controller, targets);
  if (player !== null) {
    events.push(evDamagePlayer(source, player, amount));
    events.push(changeLife(next, player, -amount));
    return { state: next, events };
  }

  for (const id of cardsFor(state, target, source, targets)) {
    next.cards[id]!.damage += amount;
    events.push(evDamage(source, id, amount));
  }
  return { state: next, events };
}

/**
 * Move cards to another zone.
 *
 * `dies` marks the moves that are deaths — destroy and sacrifice — which emit
 * `DIE` and fire `onDies` on the way out. Exile and bounce are not deaths and
 * fire nothing. A token is deleted by `move` as it leaves the battlefield, so
 * its definition is read before the move, not after.
 */
function relocate(state: GameState, ids: CardId[], to: Zone, dies: boolean): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];
  const deaths: Array<{ id: CardId; controller: PlayerId; from: TriggerSource }> = [];

  for (const id of ids) {
    const card = next.cards[id];
    if (!card) continue;
    const from = card.zone;
    if (from === to) continue;

    const died = dies && from === 'battlefield' && isCreature(next, id);
    const def = next.defs[card.oracleId];
    const controller = card.controller;

    next = move(next, id, from, to);
    events.push(evZoneChange(id, from, to));
    if (died) {
      events.push(evDie(id));
      deaths.push({ id, controller, from: triggersOfDef(def) });
    }
  }

  // Any state reached through `move` is a fresh clone this call owns, so the
  // triggers can be fired straight onto it.
  for (const death of deaths) {
    fireTriggers(next, events, death.from, 'onDies', death.id, death.controller);
  }
  return { state: next, events };
}

/**
 * Draw cards, one at a time, from the top of the library.
 *
 * An empty library does not throw and does not end the game here: it raises
 * `drewFromEmpty`, and the state-based action in `rules.ts` reads that flag. The
 * loss belongs with the other loss conditions, not scattered across effects.
 *
 * A library emptied only because a scry is holding its last cards is not an
 * empty library. Every scry card in the pool draws in the same breath, so
 * Preordain cast on a two-card library looks at both and then draws — and the
 * card it draws is one of the two it is looking at. Taking it back off
 * `pendingScry` is what keeps that a draw instead of a loss; leaving the flag to
 * be raised would deck a player one turn early for casting a cantrip.
 */
function draw(state: GameState, player: PlayerId, count: number): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];

  for (let i = 0; i < count; i++) {
    if (next.players[player].library.length === 0) unparkOneScriedCard(next, player);

    const top = next.players[player].library[0];
    if (top === undefined) {
      next.players[player].drewFromEmpty = true;
      break;
    }
    next = move(next, top, 'library', 'hand');
    events.push(evDraw(player, top));
  }
  return { state: next, events };
}

/**
 * Put the first card of a pending scry back on top of an empty library, so the
 * draw that follows it in the same resolution has something to take.
 *
 * The scry keeps whatever is left. With nothing left it is over — a decision
 * about no cards is not a decision, and leaving it pending would stop the game
 * to ask a question with no answer.
 *
 * `owned` must be a state the caller may mutate.
 */
function unparkOneScriedCard(owned: GameState, player: PlayerId): void {
  const pending = owned.pendingScry;
  if (!pending || pending.player !== player || pending.cards.length === 0) return;

  const returning = pending.cards[0]!;
  owned.pendingScry = { player, cards: pending.cards.slice(1) };
  if (owned.pendingScry.cards.length === 0) owned.pendingScry = null;
  owned.players[player].library.unshift(returning);
}

/**
 * Discard from the front of the hand — the cards held longest.
 *
 * The `Action` union has no discard decision, so nothing can ask a player which
 * card to pitch. Taking from the front is the deterministic choice that behaves
 * best on `draw a card, then discard a card`: the card just drawn is at the back
 * and survives. If a discard-choice action is ever added to `types.ts`, this is
 * the one place that changes.
 */
function discard(state: GameState, player: PlayerId, count: number): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];

  for (let i = 0; i < count; i++) {
    const card = next.players[player].hand[0];
    if (card === undefined) break;
    next = move(next, card, 'hand', 'graveyard');
    events.push(evZoneChange(card, 'hand', 'graveyard'));
  }
  return { state: next, events };
}

/**
 * Gain life, then fire `onLifeGain` on the permanents of the player who gained
 * it — the reading Ajani's Pridemate wants ("whenever *you* gain life"). Gaining
 * nothing triggers nothing.
 */
function gainLife(state: GameState, player: PlayerId, amount: number): ReduceResult {
  const next = cloneState(state);
  const events: GameEvent[] = [changeLife(next, player, amount)];
  if (amount <= 0) return { state: next, events };

  for (const id of [...next.players[player].battlefield]) {
    const card = next.cards[id];
    if (!card) continue;
    fireTriggers(next, events, triggersOfDef(next.defs[card.oracleId]), 'onLifeGain', id, card.controller);
  }
  return { state: next, events };
}

/** Life loss is not damage: no `DAMAGE` event, and nothing marks a permanent. */
function loseLife(state: GameState, player: PlayerId, amount: number): ReduceResult {
  const next = cloneState(state);
  return { state: next, events: [changeLife(next, player, -amount)] };
}

/**
 * Pump.
 *
 * `endOfTurn` writes `tempPump`, which **stacks additively** — two Giant Growths
 * on one creature are +6/+6 — and is wiped at cleanup by `rules.ts`.
 *
 * `permanent` has nowhere to live on a `CardInstance` except counters, so a
 * symmetric permanent pump becomes `+1/+1` (or `-1/-1`) counters. An asymmetric
 * one is unrepresentable and throws rather than silently expiring at cleanup:
 * per spec §13 an engine bug is loud. No card in the pool authors one.
 */
function pump(
  state: GameState,
  effect: Extract<Effect, { kind: 'pump' }>,
  ids: CardId[],
): ReduceResult {
  if (effect.duration === 'permanent') {
    if (effect.power !== effect.toughness) {
      throw new Error(
        `pump: a permanent ${effect.power}/${effect.toughness} cannot be represented — ` +
          'only symmetric permanent pump maps onto counters',
      );
    }
    const counter: CounterKind = effect.power >= 0 ? '+1/+1' : '-1/-1';
    return addCounter(state, counter, Math.abs(effect.power), ids);
  }

  const next = cloneState(state);
  for (const id of ids) {
    const card = next.cards[id]!;
    card.tempPump = {
      power: card.tempPump.power + effect.power,
      toughness: card.tempPump.toughness + effect.toughness,
    };
  }
  return { state: next, events: [] };
}

/**
 * Grant a keyword until end of turn.
 *
 * A keyword a card already has is not listed twice — `hasKeyword` is a
 * membership test, so a duplicate would be invisible in play and only show up as
 * noise in a snapshot. A `permanent` grant has no home on a `CardInstance`
 * (`tempKeywords` is cleared at cleanup) and throws for the same reason an
 * asymmetric permanent pump does: permanent grants are what auras and `keyword`
 * statics are for.
 */
function grantKeyword(
  state: GameState,
  effect: Extract<Effect, { kind: 'grantKeyword' }>,
  ids: CardId[],
): ReduceResult {
  if (effect.duration === 'permanent') {
    throw new Error(
      `grantKeyword: "${effect.keyword}" cannot be granted permanently — ` +
        'use an aura or a keyword static ability',
    );
  }

  const next = cloneState(state);
  for (const id of ids) {
    const card = next.cards[id]!;
    if (card.tempKeywords.includes(effect.keyword)) continue;
    card.tempKeywords = [...card.tempKeywords, effect.keyword];
  }
  return { state: next, events: [] };
}

/** Tap or untap. A permanent already in that state is left alone and silent. */
function setTapped(state: GameState, ids: CardId[], tapped: boolean): ReduceResult {
  const next = cloneState(state);
  const events: GameEvent[] = [];

  for (const id of ids) {
    const card = next.cards[id]!;
    if (card.tapped === tapped) continue;
    card.tapped = tapped;
    events.push(tapped ? evTap(id) : evUntap(id));
  }
  return { state: next, events };
}

/** Counters are permanent: they survive cleanup and leave only with the card. */
function addCounter(
  state: GameState,
  counter: CounterKind,
  count: number,
  ids: CardId[],
): ReduceResult {
  const next = cloneState(state);
  const events: GameEvent[] = [];

  for (const id of ids) {
    const card = next.cards[id]!;
    card.counters = { ...card.counters, [counter]: card.counters[counter] + count };
    events.push(evCounterAdd(id, counter, count));
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A stable oracle id for a token, derived from everything that distinguishes
 * one: two 1/1 white Soldiers share a definition, a 1/1 white Soldier with
 * flying gets its own.
 */
function tokenOracleId(spec: TokenSpec): OracleId {
  const parts = ['token', slug(spec.name), `${spec.power}-${spec.toughness}`];
  if (spec.colors.length > 0) parts.push(spec.colors.join('').toLowerCase());
  if (spec.subtypes.length > 0) parts.push(spec.subtypes.map(slug).join('-'));
  if (spec.keywords.length > 0) parts.push(spec.keywords.map(slug).join('-'));
  return parts.join('-');
}

/** The synthesized definition a token is registered under. */
function tokenDef(oracleId: OracleId, spec: TokenSpec): CardDef {
  return {
    oracleId,
    name: spec.name,
    manaCost: {},
    cmc: 0,
    colors: [...spec.colors],
    cardTypes: ['creature'],
    subtypes: [...spec.subtypes],
    power: spec.power,
    toughness: spec.toughness,
    oracleText: '',
    keywords: [...spec.keywords],
    statics: [],
    triggers: [],
    activated: [],
    spellEffects: [],
    targets: [],
    artist: '',
    art: spec.art,
    image: spec.art,
  };
}

/**
 * Put tokens onto the controller's battlefield as real `CardInstance`s.
 *
 * A token is a first-class permanent here: it has an id, it can be targeted,
 * blocked, pumped, and counted, and it ceases to exist when it leaves the
 * battlefield (`move` handles that). Its definition is registered in
 * `state.defs` so every reader — `powerOf`, the bot, the UI — treats it like any
 * other card, and its `tokenSpec` is kept so the UI can render it without one.
 *
 * `defs` is shared by reference across clones, so the map is *replaced*, never
 * written into: mutating it would reach back into the caller's state.
 */
function createToken(
  state: GameState,
  spec: TokenSpec,
  count: number,
  controller: PlayerId,
): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];

  const oracleId = tokenOracleId(spec);
  if (!next.defs[oracleId]) {
    next.defs = { ...next.defs, [oracleId]: tokenDef(oracleId, spec) };
  }

  for (let i = 0; i < count; i++) {
    const made = newInstance(next, oracleId, controller, 'battlefield');
    next = made.state;
    const card = next.cards[made.id]!;
    card.isToken = true;
    card.tokenSpec = {
      ...spec,
      colors: [...spec.colors],
      subtypes: [...spec.subtypes],
      keywords: [...spec.keywords],
    };
    events.push(evTokenCreate(made.id));
    // A token arriving is a creature arriving. Skipping this is how a Soldier token
    // silently fails to feed every lifegain engine on the board.
    notifyEnteredBattlefield(next, made.id, events);
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Scry, mana, counterspells
// ---------------------------------------------------------------------------

/**
 * Set up a scry rather than resolving one.
 *
 * The controller decides what goes to the bottom, and that decision arrives
 * later as a `scryDecision` action. Parking the cards on `pendingScry` keeps the
 * engine a pure function of state and actions instead of something that has to
 * ask a question mid-resolution. An empty library has nothing to decide.
 *
 * The cards come **off** the library while the decision is pending, and
 * `scryDecision` in `rules.ts` is what puts them back — kept ones on top,
 * bottomed ones underneath. Leaving them in place instead is not a harmless
 * shortcut: this engine keeps applying the rest of the spell's effects while the
 * question is outstanding, and every scry card in the pool draws in the same
 * breath ("Scry 1. Draw a card."). A draw off a library that still held the
 * parked card put that card in hand *and* left `pendingScry` holding it, so the
 * decision then re-inserted a card that was already in the player's hand — one
 * physical card in two zones at once, which is how a library grows a duplicate
 * and a battlefield ends up offering the same creature twice as an attacker.
 *
 * The cost of parking them properly is that a draw in the same resolution draws
 * from *beneath* the cards being looked at. That is the closest this
 * architecture gets to the real timing: a scry that sends a card to the bottom
 * behaves exactly as Magic says, and one that keeps a card on top gets it a draw
 * later than Magic would. Neither ever hands the player back the card they just
 * rejected, which is the mistake worth avoiding.
 */
function scry(state: GameState, controller: PlayerId, count: number): ReduceResult {
  const cards = state.players[controller].library.slice(0, count);
  const next = cloneState(state);
  if (cards.length === 0) return { state: next, events: [] };

  next.players[controller].library = next.players[controller].library.slice(cards.length);
  next.pendingScry = { player: controller, cards };
  return { state: next, events: [evScry(controller, cards.length)] };
}

/** Float one mana of each listed color in the controller's pool. */
function addMana(state: GameState, controller: PlayerId, colors: Color[]): ReduceResult {
  const next = cloneState(state);
  const pool = next.players[controller].manaPool;
  for (const color of colors) {
    pool[color] = (pool[color] ?? 0) + 1;
  }
  return { state: next, events: [] };
}

/**
 * Remove the top object on the stack that this effect did not come from.
 *
 * "Non-self" matters because a counterspell is itself on the stack while it
 * resolves — countering itself would be the shortest infinite loop in the game.
 * A countered spell goes to its owner's graveyard; a countered *triggered
 * ability* has no card to move, so its source stays exactly where it is.
 */
function counterSpell(state: GameState, source: CardId, targets: TargetSelection): ReduceResult {
  let index = -1;

  // Honor the target the player was made to choose. Falling through to "topmost" would
  // let a counterspell with a restricted filter counter an object it may not legally
  // point at, which is a rules break the UI has no way to show.
  if (Array.isArray(targets) && targets.length > 0) {
    const wanted = targets[targets.length - 1]!;
    index = state.stack.findIndex((object) => object.source === wanted && object.source !== source);
  }

  if (index < 0) {
    for (let i = state.stack.length - 1; i >= 0; i--) {
      if (state.stack[i]!.source !== source) {
        index = i;
        break;
      }
    }
  }

  const next = cloneState(state);
  if (index < 0) return { state: next, events: [] };

  const object = next.stack.splice(index, 1)[0]!;
  const events: GameEvent[] = [evCountered(object.source)];

  const card = next.cards[object.source];
  if (object.isTriggered || !card || card.zone !== 'stack') return { state: next, events };

  events.push(evZoneChange(object.source, 'stack', 'graveyard'));
  return { state: move(next, object.source, 'stack', 'graveyard'), events };
}
