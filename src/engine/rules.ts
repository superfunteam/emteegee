/**
 * The reducer: priority, the stack, phases, and state-based actions.
 *
 * This is the only module that moves the game forward in time. `actions.ts`
 * says what is legal, `effects.ts` says what a descriptor means, `combat.ts`
 * says who dealt what to whom — and this file decides *when* each of them runs.
 *
 * Five rules hold throughout:
 *
 * 1. **Pure.** No DOM, no clock, no `Math.random`, no `console`. Randomness
 *    would come from `makeRng(state.rngSeed)`; nothing here needs any.
 * 2. **The input state is never touched.** Everything clones through
 *    `cloneState` (or through `move` / `payMana` / `applyEffect`, which clone
 *    themselves) and mutates only the copy it owns. A helper that takes an
 *    `owned` state says so in its signature comment.
 * 3. **Every mutator takes a `GameState` and returns `{ state, events }`.**
 *    Never a `ReduceResult` in. Callers thread the state and concatenate the
 *    events themselves, which is what lets any of these be called on its own.
 * 4. **`legalActions` is the only definition of legal.** `reduce` gates on
 *    `isLegal` and then trusts the action completely. There is no second
 *    rulebook here, and a rule check written in this file would be the bug.
 * 5. **State-based actions run after every action and every resolution**, not
 *    at phase boundaries. A creature that becomes lethally damaged in the
 *    middle of a stack resolution dies right there.
 *
 * ## Priority
 *
 * `GameState` has no "how many players have passed in a row" counter, and the
 * type contract is closed, so succession is derived instead: each phase has a
 * default holder — the active player, except in `declareBlockers`, where the
 * defender is the one with a decision to make — and priority returns to that
 * holder after every action and every resolution. So a player passing *while*
 * they hold priority hands it over, and a player passing when they do not is
 * the second pass in succession: the stack resolves, or the phase advances.
 *
 * Two decisions outrank the phase and hold priority themselves: a pending scry,
 * which nobody else can answer, and the pre-game mulligan, where priority is the
 * only record of whose opening hand is being decided.
 *
 * ## Before turn one
 *
 * {@link beginMulligans} winds a dealt game back to turn zero — the pre-game,
 * see `MULLIGAN_TURN` in `actions.ts` — where the only legal moves are `mulligan`
 * and `keepHand`. The human decides, then the Magician, and the second keep
 * starts turn one at `main1`. `createGame` still deals straight into a playable
 * game, so nothing that does not want a mulligan step has to have one.
 *
 * ## Pacing
 *
 * Spec §9.4: the game skips only those stops where advancing is the sole legal
 * action. Two mechanisms implement it. {@link advancePhase} handles the phase
 * stops: "keep going while the player with priority has nothing but `pass` (or
 * an empty combat declaration, which is the same thing wearing a different
 * name) to choose from". {@link settlePriority} extends the same rule to stack
 * windows: after every action `reduce` performs, any priority stop whose holder
 * has no real choice is passed through automatically, so a spell nobody can
 * respond to resolves inside the very `reduce` that cast it. Every phase passed
 * through still emits a `PHASE` event and every auto-resolved spell its `CAST`
 * and `RESOLVE`, so the animator can show untap, draw, and the spell landing
 * even though nobody tapped to acknowledge them.
 */

import type {
  Action,
  CardDef,
  CardId,
  CardType,
  GameEvent,
  GameState,
  ManaCost,
  PlayerId,
  ReduceResult,
  StackObject,
  TargetFilter,
  TargetSelection,
} from './types';
import { assertNever, PHASE_ORDER, STARTING_HAND } from './types';
import {
  cloneState,
  hasKeyword,
  inst,
  isCreature,
  move,
  opponentOf,
  payMana,
  toughnessOf,
} from './state';
import { inMulligan, isLegal, legalActions, MULLIGAN_TURN } from './actions';
import { applyEffect, applyEffects } from './effects';
import { declareAttackers, declareBlockers, resolveDamageStep } from './combat';
import { makeRng, shuffle, type Rng } from './rng';
import { fireTriggers, notifyEnteredBattlefield, triggerSourceOf, triggersOfDef } from './triggers';
import { evCast, evPhase, evPlay, evResolve, evTap, evUntap, evWin, evZoneChange } from './events';

/** Every mana symbol that can appear in a cost. */
const MANA_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/**
 * The `EffectTarget` used when this file hands `applyEffect` a selection it has
 * already decided on. A `TargetFilter` target means "use the selection"; the
 * filter's own fields are never consulted.
 */
const SELECTED: TargetFilter = {};

/** Card types that stay on the battlefield once their spell resolves. */
const PERMANENT_TYPES: readonly CardType[] = ['creature', 'enchantment', 'artifact', 'land'];

/**
 * The source a turn-based draw is attributed to.
 *
 * The draw step is not a card doing something, but `applyEffect` is written
 * from a card's point of view. `draw` never reads its source — only the events
 * it emits name a card, and `DRAW` names the card drawn — so this is a label,
 * not a lookup. Reusing the interpreter keeps `drewFromEmpty` in exactly one
 * place instead of two.
 */
const TURN_BASED: CardId = 'the game';

/**
 * How many sweeps of state-based actions is too many.
 *
 * Every sweep that changes anything removes at least one permanent from the
 * battlefield, so a real board settles in a handful. Reaching this bound means
 * a rule is undoing what the sweep before it did, and spec §13 says an engine
 * bug is loud.
 */
const SBA_LIMIT = 100;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Who holds priority at the start of this phase, and who it returns to after
 * every action and resolution.
 *
 * The active player, except at `declareBlockers`: blocks are the defender's
 * decision, and `actions.ts` only enumerates them for the defender, so the
 * defender is the one who must be holding priority when that phase opens.
 *
 * A pending scry outranks the phase entirely. The cards are already off the top
 * of the library and the game cannot go anywhere until their controller says
 * where they belong, so they hold priority until they do — which is what makes
 * "nothing else may happen" true for every path into this function rather than
 * only for the resolution that set the scry up.
 */
function defaultPriority(state: GameState): PlayerId {
  if (state.pendingScry) return state.pendingScry.player;
  return state.phase === 'declareBlockers' ? opponentOf(state.active) : state.active;
}

/** The same state seen from the other player's side of the priority question. */
function withPriority(state: GameState, player: PlayerId): GameState {
  if (state.priority === player) return state;
  const next = cloneState(state);
  next.priority = player;
  return next;
}

/**
 * Is this action indistinguishable from passing?
 *
 * Declaring no attackers and declaring no blockers change nothing about the
 * game — they *are* "advance", spelled as a declaration. Counting them as real
 * choices would stop the game at the declare-attackers step of every turn with
 * an empty board, which is exactly the stop spec §9.4 says to skip.
 */
function isNoOp(action: Action): boolean {
  switch (action.kind) {
    case 'pass':
      return true;
    case 'declareAttackers':
      return action.attackers.length === 0;
    case 'declareBlockers':
      return action.blocks.length === 0;
    // Tapping a land for mana you have not decided to spend is not a decision the
    // game is waiting on — it is a convenience offered in every phase to anyone
    // holding an untapped land. Counting it as a real choice would stop the game at
    // untap, upkeep, draw, and end of every turn from the second land onward, which
    // is the entire class of empty stop spec §9.4 exists to remove.
    case 'tapLand':
      return true;
    default:
      return false;
  }
}

/** Does this player have anything to decide right now, other than to advance? */
function hasRealChoice(state: GameState, player: PlayerId): boolean {
  return legalActions(withPriority(state, player)).some((action) => !isNoOp(action));
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/** Two costs paid together, e.g. a spell plus the ward tax on its target. */
function addCost(a: ManaCost, b: ManaCost): ManaCost {
  const out: ManaCost = { ...a };
  for (const key of MANA_KEYS) {
    const extra = b[key] ?? 0;
    if (extra > 0) out[key] = (out[key] ?? 0) + extra;
  }
  return out;
}

/**
 * The ward tax this selection costs, on top of whatever is doing the targeting.
 *
 * Ward only taxes an opponent, and a warded card with no `wardCost` authored
 * taxes nothing — the same reading `actions.ts` used when it decided the action
 * was affordable. The two must agree: a payment that charged less than legality
 * assumed would let a player cheat ward by casting through the UI.
 */
function wardTax(state: GameState, targets: TargetSelection, caster: PlayerId): ManaCost {
  if (!Array.isArray(targets)) return {};
  let out: ManaCost = {};
  for (const id of targets) {
    const card = state.cards[id];
    if (!card || card.controller === caster) continue;
    if (!hasKeyword(state, id, 'ward')) continue;
    out = addCost(out, state.defs[card.oracleId]?.wardCost ?? {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Definitions and triggers
// ---------------------------------------------------------------------------

/** The definition behind an instance, or nothing for a token that has none. */
function defOf(state: GameState, card: CardId): CardDef | undefined {
  const instance = state.cards[card];
  if (!instance) return undefined;
  return state.defs[instance.oracleId];
}

/**
 * This file owns the four trigger events that belong to it — `onCast` when a
 * spell goes on the stack, `onEnterBattlefield` and `onOtherEnterBattlefield`
 * when a permanent arrives, and `onUpkeep` at the upkeep step. Every other
 * `TriggerEvent` is fired by the module that causes it, so nothing fires twice.
 * The enqueue itself, its two suppressions, and the targets a trigger chooses
 * all live in `triggers.ts`.
 */

/**
 * A permanent has arrived on a battlefield: it is summoning sick, its own
 * enter-the-battlefield triggers go on the stack, and the permanents already
 * there notice.
 *
 * `move` deliberately does not set `summonedThisTurn` — it is a zone change,
 * not an arrival — so a creature cast from hand would otherwise be able to
 * attack the turn it landed.
 *
 * `onOtherEnterBattlefield` is the Soul Warden reading: *another creature you
 * control* entering. So it fires only for creatures, only on the permanents of
 * the same player, and never on the arriving creature itself.
 */
function enteredBattlefield(owned: GameState, card: CardId, events: GameEvent[]): void {
  notifyEnteredBattlefield(owned, card, events);
}

// ---------------------------------------------------------------------------
// State-based actions
// ---------------------------------------------------------------------------

/** Creatures that should already be in a graveyard. */
function dyingCreatures(state: GameState): CardId[] {
  const out: CardId[] = [];
  for (const player of state.players) {
    for (const id of player.battlefield) {
      const card = state.cards[id];
      if (!card || !isCreature(state, id)) continue;
      const toughness = toughnessOf(state, id);
      if (toughness <= 0 || (card.damage > 0 && card.damage >= toughness)) out.push(id);
    }
  }
  return out;
}

/**
 * Auras with nothing left to enchant.
 *
 * An aura whose host died, was exiled, or was bounced has nowhere to be — and
 * so does one that resolved with no legal target at all, which is why an
 * unattached aura counts as orphaned rather than as merely unattached.
 */
function orphanedAuras(state: GameState): CardId[] {
  const out: CardId[] = [];
  for (const player of state.players) {
    for (const id of player.battlefield) {
      const card = state.cards[id];
      if (!card) continue;
      if (!defOf(state, id)?.statics.some((ability) => ability.kind === 'aura')) continue;
      const host = card.attachedTo === undefined ? undefined : state.cards[card.attachedTo];
      if (host && host.zone === 'battlefield') continue;
      out.push(id);
    }
  }
  return out;
}

/**
 * The player who has lost, if one has.
 *
 * Two conditions, per spec §3: at zero life or below, or having tried to draw
 * from an empty library. When both players meet one at the same moment the
 * rules call it a draw, which `GameState.winner` cannot express — so the active
 * player, whose turn produced the situation, is the one who loses.
 */
function losingPlayer(state: GameState): PlayerId | null {
  const lost = (player: PlayerId): boolean =>
    state.players[player].life <= 0 || state.players[player].drewFromEmpty;

  const zero = lost(0);
  const one = lost(1);
  if (zero && one) return state.active;
  if (zero) return 0;
  if (one) return 1;
  return null;
}

/**
 * Apply state-based actions until the game stops changing.
 *
 * Creatures with lethal damage or no toughness die, auras with no host follow
 * them, and a player at zero life or out of library hands the game to their
 * opponent. Deaths go through the `destroy` effect so there is exactly one
 * death path in the engine: `DIE`, `ZONE_CHANGE`, and `onDies` come out of
 * `effects.ts` exactly as they do for a removal spell.
 *
 * The loop repeats because a death can cause a death — a lord dying shrinks
 * everything it was pumping, an aura falls off a creature that was holding it
 * up — and is bounded at {@link SBA_LIMIT} so a rule that undoes its own sweep
 * surfaces as a loud throw rather than a hung tab.
 *
 * A finished game is left exactly as it is: the winner is not re-decided and
 * `WIN` is not emitted twice.
 */
export function stateBasedActions(state: GameState): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];
  if (next.winner !== null) return { state: next, events };

  for (let sweep = 0; ; sweep++) {
    if (sweep >= SBA_LIMIT) {
      throw new Error(
        `stateBasedActions: did not settle after ${SBA_LIMIT} sweeps — this is an engine bug`,
      );
    }

    const doomed = [...dyingCreatures(next), ...orphanedAuras(next)];
    if (doomed.length > 0) {
      const first = doomed[0]!;
      const result = applyEffect(
        next,
        { kind: 'destroy', target: SELECTED },
        first,
        inst(next, first).controller,
        doomed,
      );
      next = result.state;
      events.push(...result.events);
      continue;
    }

    const loser = losingPlayer(next);
    if (loser !== null) {
      const winner = opponentOf(loser);
      next = cloneState(next);
      next.winner = winner;
      events.push(evWin(winner));
    }
    return { state: next, events };
  }
}

// ---------------------------------------------------------------------------
// Stack resolution
// ---------------------------------------------------------------------------

/** An aura enters attached to the target its controller chose on cast. */
function attachAura(owned: GameState, object: StackObject): void {
  if (!Array.isArray(object.targets)) return;
  const host = object.targets.find((id) => owned.cards[id]?.zone === 'battlefield');
  if (host === undefined) return;
  owned.cards[object.source]!.attachedTo = host;
}

/**
 * Resolve the top object on the stack — the **last** element, because the stack
 * is last in, first out.
 *
 * Three kinds of object resolve differently:
 *
 * - a **permanent spell** enters the battlefield, attaches if it is an aura,
 *   and fires `onEnterBattlefield`;
 * - any other **spell** applies its effects and goes to its owner's graveyard;
 * - an **ability**, triggered or activated, applies its effects and has no card
 *   to move. Its source is on the battlefield (or already in a graveyard, if it
 *   was sacrificed to pay for itself), which is exactly what tells the two
 *   apart: only a spell is in the `stack` zone while it resolves.
 *
 * `resolvingTrigger` is set for the duration of a triggered ability and is the
 * structural guard against loops (spec §5) — `effects.ts` and `combat.ts` both
 * read it and decline to enqueue anything while it is set. This is the only
 * place that writes it.
 *
 * State-based actions run before this returns, so the invariant holds for any
 * caller and not only for {@link reduce}. An empty stack is a no-op rather than
 * a throw: there is nothing incoherent about asking a settled game to resolve.
 */
export function resolveTop(state: GameState): ReduceResult {
  let next = cloneState(state);
  if (next.stack.length === 0) return { state: next, events: [] };

  const object = next.stack.pop()!;
  const events: GameEvent[] = [evResolve(object.source)];
  next.resolvingTrigger = object.isTriggered;

  const card = next.cards[object.source];
  const definition = card ? next.defs[card.oracleId] : undefined;
  const isSpell = !object.isTriggered && card !== undefined && card.zone === 'stack';
  const isPermanent =
    isSpell && definition !== undefined && definition.cardTypes.some((t) => PERMANENT_TYPES.includes(t));

  if (isPermanent) {
    next = move(next, object.source, 'stack', 'battlefield');
    events.push(evZoneChange(object.source, 'stack', 'battlefield'));
    attachAura(next, object);
    enteredBattlefield(next, object.source, events);
  }

  // `applyEffects` either clones or, with nothing to apply, hands back the very
  // state it was given — which is the clone this call already owns either way.
  const applied = applyEffects(next, [...object.effects], object.source, object.controller, object.targets);
  next = applied.state;
  events.push(...applied.events);

  if (isSpell && !isPermanent && next.cards[object.source]?.zone === 'stack') {
    next = move(next, object.source, 'stack', 'graveyard');
    events.push(evZoneChange(object.source, 'stack', 'graveyard'));
  }

  next.priority = defaultPriority(next);

  // The guard must still be set while state-based actions run. A trigger that deals
  // lethal damage does not kill anything itself — damage only marks, and the sweep
  // below is what destroys the creature and fires its `onDies`. Clearing the flag
  // before the sweep would let a trigger enqueue a trigger through that back door,
  // which is exactly the loop the flag exists to make structurally impossible.
  const settled = stateBasedActions(next);
  const resolved = settled.state;
  resolved.resolvingTrigger = false;

  return { state: resolved, events: [...events, ...settled.events] };
}

// ---------------------------------------------------------------------------
// Turn-based actions
// ---------------------------------------------------------------------------

/**
 * Untap: everything the active player controls straightens up, and everything
 * they control has now been there since the turn began, so summoning sickness
 * lifts. Their land drop comes back with it.
 */
function untapStep(owned: GameState): ReduceResult {
  const events: GameEvent[] = [];
  const player = owned.players[owned.active];
  player.landPlayedThisTurn = false;

  for (const id of player.battlefield) {
    const card = owned.cards[id];
    if (!card) continue;
    if (card.tapped) {
      card.tapped = false;
      events.push(evUntap(id));
    }
    card.summonedThisTurn = false;
  }
  return { state: owned, events };
}

/** Upkeep: the active player's permanents fire `onUpkeep`. */
function upkeepStep(owned: GameState): ReduceResult {
  const events: GameEvent[] = [];
  for (const id of [...owned.players[owned.active].battlefield]) {
    const card = owned.cards[id];
    if (!card) continue;
    fireTriggers(owned, events, triggerSourceOf(owned, id), 'onUpkeep', id, card.controller);
  }
  return { state: owned, events };
}

/**
 * Draw: one card for the active player.
 *
 * Player 0 is the human and is always on the play (spec §3), so they skip the
 * draw on turn one. The Magician, always on the draw, gets the extra card.
 */
function drawStep(owned: GameState): ReduceResult {
  if (owned.turn === 1 && owned.active === 0) return { state: owned, events: [] };
  return applyEffect(owned, { kind: 'draw', player: 'you', count: 1 }, TURN_BASED, owned.active, null);
}

/** End of combat: everything forgets it was in a fight. */
function endCombatStep(owned: GameState): ReduceResult {
  for (const card of Object.values(owned.cards)) {
    card.attacking = false;
    card.blocking = undefined;
    card.blockedBy = [];
  }
  return { state: owned, events: [] };
}

/**
 * Cleanup: temporary pump and granted keywords expire and marked damage wears
 * off, all at once.
 *
 * Simultaneously matters. A 2/2 pumped to 5/5 with four damage marked on it
 * survives the turn, because the damage is gone by the time the toughness
 * drops — checking the two in sequence would kill it.
 */
function cleanupStep(owned: GameState): ReduceResult {
  for (const card of Object.values(owned.cards)) {
    card.tempPump = { power: 0, toughness: 0 };
    card.tempKeywords = [];
    card.damage = 0;
  }
  return { state: owned, events: [] };
}

/**
 * Move to the next phase and do whatever that phase does on its own.
 *
 * After `cleanup` the turn passes: the other player becomes active, the turn
 * number goes up, and `untap` opens their turn.
 *
 * Combat damage resolves on entry to `combatDamage`, because `combat.ts`
 * settles the first-strike step and the regular step together in one call —
 * "a blocker killed by first strike deals no damage back" is decided inside
 * that call, not between two phases. `firstStrikeDamage` is therefore the last
 * priority window before any damage is dealt.
 *
 * Mana pools empty at every phase change, so mana floated in a main phase
 * cannot be spent in combat.
 */
function enterNextPhase(state: GameState): ReduceResult {
  const index = PHASE_ORDER.indexOf(state.phase);
  if (index < 0) throw new Error(`advancePhase: "${state.phase}" is not a phase`);

  const wrapping = index === PHASE_ORDER.length - 1;
  let next = cloneState(state);

  if (wrapping) {
    next.active = opponentOf(next.active);
    next.turn += 1;
  }
  next.phase = wrapping ? PHASE_ORDER[0]! : PHASE_ORDER[index + 1]!;
  next.priority = defaultPriority(next);
  next.resolvingTrigger = false;
  for (const player of next.players) player.manaPool = {};

  const events: GameEvent[] = [evPhase(next.phase, next.active, next.turn)];

  let step: ReduceResult;
  switch (next.phase) {
    case 'untap':
      step = untapStep(next);
      break;
    case 'upkeep':
      step = upkeepStep(next);
      break;
    case 'draw':
      step = drawStep(next);
      break;
    case 'combatDamage':
      step = resolveDamageStep(next);
      break;
    case 'endCombat':
      step = endCombatStep(next);
      break;
    case 'cleanup':
      step = cleanupStep(next);
      break;
    default:
      step = { state: next, events: [] };
  }

  next = step.state;
  events.push(...step.events);
  return { state: next, events };
}

/**
 * Advance until the game reaches a stop worth stopping at.
 *
 * A stop is worth stopping at when the player with priority has a real choice
 * to make, when something is waiting on the stack, or when the game is over.
 * Everything else is passed through, and every phase passed through emits its
 * `PHASE` event — spec §9.4 skips the *tap*, not the animation.
 *
 * The loop is bounded by the length of the phase list, which is one full turn.
 * Reaching the bound is not an engine bug: a player who is mana-screwed with an
 * empty board genuinely has nothing to do for a whole turn, and throwing at
 * them would be a crash in a legal game. It simply stops, and the next `pass`
 * carries on from there.
 */
export function advancePhase(state: GameState): ReduceResult {
  let next = cloneState(state);
  const events: GameEvent[] = [];
  if (next.winner !== null) return { state: next, events };

  for (let step = 0; step < PHASE_ORDER.length; step++) {
    const entered = enterNextPhase(next);
    next = entered.state;
    events.push(...entered.events);

    const settled = stateBasedActions(next);
    next = settled.state;
    events.push(...settled.events);

    if (next.winner !== null) break;
    if (next.stack.length > 0) break;
    if (hasRealChoice(next, next.priority)) break;
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Pass.
 *
 * Passing while holding priority hands it to the other player — unless they
 * have nothing but `pass` to choose from, in which case making them tap for it
 * would be the empty stop spec §9.4 exists to remove. Passing when the other
 * player already has had their say is the second pass in succession: the top of
 * the stack resolves, or, with nothing waiting, the phase advances.
 */
function pass(state: GameState): ReduceResult {
  if (state.priority === defaultPriority(state)) {
    const other = opponentOf(state.priority);
    if (hasRealChoice(state, other)) {
      const next = cloneState(state);
      next.priority = other;
      return { state: next, events: [] };
    }
  }

  if (state.stack.length > 0) return resolveTop(state);
  return advancePhase(state);
}

/**
 * How many automatic passes is too many.
 *
 * {@link settlePriority} is structurally finite — see its comment for the
 * argument — so a legal game can never come near this. Reaching it means some
 * rule is undoing the progress the pass before it made, and spec §13 says an
 * engine bug is loud, not a hung tab.
 */
const SETTLE_LIMIT = 100_000;

/**
 * Pass automatically through every stop where the player with priority has
 * nothing to decide.
 *
 * Spec §9.4 — the game skips only those stops where advancing is the sole
 * legal action — extended from phase stops to stack windows. A spell or
 * trigger nobody can respond to is not a response window, it is ceremony: this
 * is what makes it resolve inside the same `reduce` that created it, `CAST`
 * and `RESOLVE` events and all, instead of stopping at a "Pass" button no card
 * can justify.
 *
 * Each automatic pass is {@link pass}, exactly as if the player had tapped it,
 * so it hands priority over, resolves the top of the stack, or advances the
 * phase — whichever a manual pass would have done. The loop stops the moment
 * anyone has a real decision:
 *
 * - the game is over, or a scry is pending — the scry outranks everything, and
 *   only its controller can answer it;
 * - the pre-game mulligan — keeping or mulliganing a hand is always a real
 *   choice;
 * - the priority holder has any action that is not a no-op: a castable instant
 *   (a *real* response window, whether the holder is the human or the bot), a
 *   combat declaration with creatures in it, an ordering worth choosing.
 *
 * The choice test is {@link hasRealChoice} — the same predicate `pass` and
 * `advancePhase` already use, so there is exactly one definition of "nothing
 * to do" in the engine.
 *
 * **The loop is finite.** Every iteration either hands priority to a player
 * with a real choice (and exits), resolves one stack object, or advances at
 * least one phase. No spell is ever cast here, and a resolving trigger cannot
 * enqueue another (`resolvingTrigger`), so the stack drains in finitely many
 * steps between phase changes. Every wrap of the phase list is a turn, every
 * turn draws a card, and a library is finite — so a game in which nobody ever
 * gets a real choice ends, by decking, with a winner, and the loop exits.
 * {@link SETTLE_LIMIT} sits far above all of that as the loud guard.
 */
function settlePriority(state: GameState): ReduceResult {
  let next = state;
  const events: GameEvent[] = [];

  for (let passes = 0; ; passes++) {
    if (passes >= SETTLE_LIMIT) {
      throw new Error(
        `settlePriority: did not settle after ${SETTLE_LIMIT} automatic passes — this is an engine bug`,
      );
    }

    if (next.winner !== null) break;
    if (next.pendingScry) break;
    if (inMulligan(next)) break;
    if (hasRealChoice(next, next.priority)) break;

    const passed = pass(next);
    next = passed.state;
    events.push(...passed.events);
  }

  return { state: next, events };
}

/**
 * Play a land: straight onto the battlefield, no stack involved, and the land
 * drop for the turn is spent.
 */
function playLand(state: GameState, card: CardId): ReduceResult {
  const player = inst(state, card).controller;
  const next = move(state, card, 'hand', 'battlefield');
  const events: GameEvent[] = [evPlay(player, card), evZoneChange(card, 'hand', 'battlefield')];

  next.players[player].landPlayedThisTurn = true;
  enteredBattlefield(next, card, events);
  next.priority = defaultPriority(next);
  return { state: next, events };
}

/**
 * Cast a spell: pay for it, put it on the stack, and fire `onCast`.
 *
 * The cost is the printed cost plus the ward tax of the targets this selection
 * chose — the same sum `actions.ts` checked affordability against, so a player
 * is never charged more or less than the action they were offered.
 *
 * The spell goes on the stack *before* its cast triggers, so those triggers sit
 * above it and resolve first.
 */
function castSpell(state: GameState, card: CardId, targets: TargetSelection): ReduceResult {
  const instance = inst(state, card);
  const player = instance.controller;
  const definition = state.defs[instance.oracleId];
  if (!definition) throw new Error(`castSpell: no card definition for "${instance.oracleId}"`);

  let next = payMana(state, player, addCost(definition.manaCost, wardTax(state, targets, player)));
  next = move(next, card, 'hand', 'stack');
  const events: GameEvent[] = [evCast(player, card, targets), evZoneChange(card, 'hand', 'stack')];

  next.stack.push({
    id: `spell#${next.nextId}`,
    source: card,
    controller: player,
    effects: [...definition.spellEffects],
    targets: Array.isArray(targets) ? [...targets] : targets,
    isTriggered: false,
  });
  next.nextId += 1;

  fireTriggers(next, events, triggersOfDef(definition), 'onCast', card, player);
  next.priority = defaultPriority(next);
  return { state: next, events };
}

/**
 * Activate an ability: pay its cost, then put it on the stack.
 *
 * Costs are paid in full before anything is enqueued, so a creature sacrificed
 * to its own ability is already in the graveyard when the ability resolves —
 * and the ability still resolves, because it is an independent object.
 *
 * A mana ability does not use the stack. Nothing can respond to it, and routing
 * it through a resolution would leave the mana unavailable to the very spell it
 * was produced for.
 */
function activate(
  state: GameState,
  card: CardId,
  abilityIndex: number,
  targets: TargetSelection,
): ReduceResult {
  const instance = inst(state, card);
  const player = instance.controller;
  const ability = state.defs[instance.oracleId]?.activated[abilityIndex];
  if (!ability) throw new Error(`activate: "${card}" has no activated ability ${abilityIndex}`);

  let next = payMana(state, player, addCost(ability.cost.mana ?? {}, wardTax(state, targets, player)));
  const events: GameEvent[] = [];

  if (ability.cost.tapSelf) {
    const tapped = applyEffect(next, { kind: 'tap', target: SELECTED }, card, player, [card]);
    next = tapped.state;
    events.push(...tapped.events);
  }
  if (ability.cost.sacrificeSelf) {
    const sacrificed = applyEffect(next, { kind: 'sacrifice', target: SELECTED }, card, player, [card]);
    next = sacrificed.state;
    events.push(...sacrificed.events);
  }

  if (ability.effects.every((effect) => effect.kind === 'addMana')) {
    const produced = applyEffects(next, [...ability.effects], card, player, targets);
    next = produced.state;
    events.push(...produced.events);
    next.priority = defaultPriority(next);
    return { state: next, events };
  }

  next.stack.push({
    id: `ability#${next.nextId}`,
    source: card,
    controller: player,
    effects: [...ability.effects],
    targets: Array.isArray(targets) ? [...targets] : targets,
    isTriggered: false,
  });
  next.nextId += 1;
  next.priority = defaultPriority(next);
  return { state: next, events };
}

/**
 * A combat declaration is made once and then the step is over.
 *
 * Advancing immediately is what makes that true: `actions.ts` enumerates the
 * declaration from the phase alone, so a player left sitting in
 * `declareAttackers` after attacking would be offered a second declaration —
 * and a vigilant attacker, still untapped, would happily be declared twice.
 *
 * With a trigger on the stack the advance stops at the very next phase, so an
 * `onAttack` ability still resolves before blockers are declared.
 */
function afterDeclaration(declared: ReduceResult): ReduceResult {
  const settled = stateBasedActions(declared.state);
  const advanced = advancePhase(settled.state);
  return {
    state: advanced.state,
    events: [...declared.events, ...settled.events, ...advanced.events],
  };
}

// ---------------------------------------------------------------------------
// The opening hand
// ---------------------------------------------------------------------------

/**
 * Put a freshly dealt game into its mulligan step.
 *
 * `createGame` deals two opening hands and stops at the first main phase, which
 * is a playable game and is what every test and every bot search starts from.
 * This is the one extra move a real match makes first: it winds the clock back
 * to turn zero — the pre-game, see `MULLIGAN_TURN` in `actions.ts` — and hands
 * the human the decision. Player 0 answers, then player 1, and the second keep
 * starts turn one.
 *
 * Silent, because nothing has happened yet: the cards were dealt by
 * `createGame`, and the `PHASE` event announcing turn one comes out of the keep
 * that starts it.
 */
export function beginMulligans(state: GameState): ReduceResult {
  const next = cloneState(state);
  next.turn = MULLIGAN_TURN;
  next.phase = 'main1';
  next.active = 0;
  next.priority = 0;
  return { state: next, events: [] };
}

/**
 * The next seed in the stream.
 *
 * `state.rngSeed` is both the seed of the game and the position in it: a
 * mulligan advances it, so the second seven is a different seven and the same
 * `rngSeed` still reproduces the same game exactly. Leaving it fixed would
 * reshuffle to the identical order every time and hand the player back the hand
 * they just rejected.
 */
function advanceSeed(rng: Rng): number {
  return Math.floor(rng() * 0x1_0000_0000) >>> 0;
}

/**
 * Mulligan: the hand goes back, the library is shuffled, and seven more come
 * off the top.
 *
 * London, per spec §3 — you always draw a full seven and pay for it when you
 * keep, rather than drawing one fewer each time. The count is what the keep
 * later charges, and `legalActions` stops offering this at
 * `MAX_MULLIGANS`.
 *
 * Priority does not move: the same player looks at the new hand and decides
 * again.
 */
function mulligan(state: GameState): ReduceResult {
  const player = state.priority;
  let next = cloneState(state);
  const events: GameEvent[] = [];

  for (const id of [...next.players[player].hand]) {
    next = move(next, id, 'hand', 'library');
    events.push(evZoneChange(id, 'hand', 'library'));
  }

  const rng = makeRng(next.rngSeed);
  next.players[player].library = shuffle(next.players[player].library, rng);
  next.rngSeed = advanceSeed(rng);

  const drawn = applyEffect(
    next,
    { kind: 'draw', player: 'you', count: STARTING_HAND },
    TURN_BASED,
    player,
    null,
  );
  next = drawn.state;
  events.push(...drawn.events);

  next.players[player].mulligansTaken += 1;
  return { state: next, events };
}

/**
 * Keep: put back one card for each mulligan taken, on the bottom of the
 * library, in the order the player listed them.
 *
 * The bottom is the end of the array — index 0 is the top — so `move` already
 * puts them exactly where they belong.
 *
 * Then the decision passes: the human answers first, the Magician second, and
 * the second keep is what starts turn one. The game opens at `main1` with
 * player 0 active, which is the position `createGame` describes and the reason
 * player 0 skips a draw step they have already passed.
 */
function keepHand(state: GameState, toBottom: CardId[]): ReduceResult {
  const player = state.priority;
  let next = cloneState(state);
  const events: GameEvent[] = [];

  for (const id of toBottom) {
    next = move(next, id, 'hand', 'library');
    events.push(evZoneChange(id, 'hand', 'library'));
  }

  if (player === 0) {
    next.priority = 1;
    return { state: next, events };
  }

  next.turn = 1;
  next.phase = 'main1';
  next.active = 0;
  next.priority = 0;
  events.push(evPhase(next.phase, next.active, next.turn));
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Scry
// ---------------------------------------------------------------------------

/**
 * Answer the scry: the chosen cards go to the bottom in the order they were
 * chosen, everything else stays on top in the order it was already in.
 *
 * `effects.ts` parks the cards on `state.pendingScry` rather than asking a
 * question mid-resolution, and this is the other half of that bargain — the
 * only thing that clears it, the only thing `legalActions` will offer while it
 * is set, and the only thing that puts the parked cards back into the library
 * they were lifted out of.
 *
 * `rest` filters the looked-at cards out of the library defensively. They are
 * not in it — `scry` took them off the top — but a state assembled by hand may
 * still have them there, and reinserting a card the library already holds is
 * exactly the duplication this pairing exists to avoid.
 *
 * Silent: `SCRY` was emitted when the cards came off the top, and the decision
 * moves nothing between zones that the animator could show.
 */
function scryDecision(state: GameState, toBottom: CardId[]): ReduceResult {
  const pending = state.pendingScry;
  if (!pending) throw new Error('scryDecision: no scry is waiting on a decision');

  const next = cloneState(state);
  const looked = pending.cards;
  const library = next.players[pending.player].library;

  const kept = looked.filter((id) => !toBottom.includes(id));
  const rest = library.filter((id) => !looked.includes(id));
  next.players[pending.player].library = [...kept, ...rest, ...toBottom];

  next.pendingScry = null;
  next.priority = defaultPriority(next);
  return { state: next, events: [] };
}

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------

/**
 * Tap a land yourself and float what it makes.
 *
 * Spec §9.3: casting auto-taps, and long-pressing the mana row lets a player do
 * it by hand. The float is real mana in `PlayerState.manaPool`, and `payMana`
 * already spends the pool before it taps anything — floating mana and then
 * casting taps no second land, which is the only thing that makes this worth
 * offering at all.
 *
 * A land that could make more than one color would need a choice the `Action`
 * union has nowhere to put, so the first color it lists is the one produced. No
 * card in the pool has a second one: spec §3 puts mana abilities beyond basic
 * lands out of scope.
 *
 * Priority deliberately does not move. Every other action here hands it back to
 * the phase's default holder, but the entire point of floating mana is to spend
 * it, and a player who lost priority the moment they tapped could never cast
 * the spell they tapped for.
 */
function tapLand(state: GameState, card: CardId): ReduceResult {
  const instance = inst(state, card);
  const player = instance.controller;
  const produces = state.defs[instance.oracleId]?.producesMana;
  if (!produces || produces.length === 0) {
    throw new Error(`tapLand: "${card}" produces no mana`);
  }

  const next = cloneState(state);
  next.cards[card]!.tapped = true;
  const pool = next.players[player].manaPool;
  const color = produces[0]!;
  pool[color] = (pool[color] ?? 0) + 1;

  return { state: next, events: [evTap(card)] };
}

// ---------------------------------------------------------------------------
// Blocker ordering
// ---------------------------------------------------------------------------

/**
 * Set the order an attacker assigns its damage in.
 *
 * `combat.ts` walks `blockedBy` and gives each blocker lethal before moving on,
 * so this list is the whole of the decision: which creature the attacker is
 * willing to trade with, and which one it merely bumps into.
 *
 * Priority passes to the defender, and that is load-bearing rather than
 * cosmetic. `validateBlockerOrder` only accepts an order from a player who
 * holds priority *and* is the active player, so handing it over is what makes
 * the ordering a decision made once. Without it the position after ordering
 * offers ordering again, and anything maximising an evaluation that reordering
 * does not change — which is every evaluation, since the board is identical —
 * would sit there rearranging blockers until the tab died.
 */
function orderBlockers(state: GameState, attacker: CardId, order: CardId[]): ReduceResult {
  const next = cloneState(state);
  next.cards[attacker]!.blockedBy = [...order];
  next.cards[attacker]!.damageOrderChosen = true;

  // Priority only leaves once every gang-blocked attacker has been ordered. The
  // handoff used to be the "already decided" marker, which capped a whole combat at
  // one ordered attacker: a second one blocked by two or more silently kept its
  // declaration order. `damageOrderChosen` is that marker now, so the handoff can go
  // back to meaning what it says.
  const outstanding = legalActions(withPriority(next, next.active))
    .some((a) => a.kind === 'orderBlockers');
  if (!outstanding) next.priority = opponentOf(next.active);

  return { state: next, events: [] };
}

/**
 * The defender's window after an order is set: kept when they have something to
 * do with it, skipped when they do not.
 *
 * Same rule as everywhere else (spec §9.4) — a stop where advancing is the only
 * legal move is not a stop. With no trick to cast, ordering blockers runs
 * straight into the damage it was deciding.
 */
function afterOrdering(ordered: ReduceResult): ReduceResult {
  if (hasRealChoice(ordered.state, ordered.state.priority)) return ordered;
  const advanced = advancePhase(ordered.state);
  return { state: advanced.state, events: [...ordered.events, ...advanced.events] };
}

function dispatch(state: GameState, action: Action): ReduceResult {
  switch (action.kind) {
    case 'pass':
      return pass(state);
    case 'playLand':
      return playLand(state, action.card);
    case 'castSpell':
      return castSpell(state, action.card, action.targets);
    case 'activate':
      return activate(state, action.card, action.abilityIndex, action.targets);
    case 'declareAttackers':
      return afterDeclaration(declareAttackers(state, action.attackers));
    case 'declareBlockers':
      return afterDeclaration(declareBlockers(state, action.blocks));
    case 'orderBlockers':
      return afterOrdering(orderBlockers(state, action.attacker, action.order));
    case 'scryDecision':
      return scryDecision(state, action.toBottom);
    case 'mulligan':
      return mulligan(state);
    case 'keepHand':
      return keepHand(state, action.toBottom);
    case 'tapLand':
      return tapLand(state, action.card);

    default:
      return assertNever(action, 'reduce');
  }
}

/**
 * Apply one action and report everything that happened because of it.
 *
 * The action is checked against {@link isLegal} — a membership test against
 * `legalActions`, not a second rulebook — and an illegal one throws. Reaching
 * that throw is an engine bug rather than user error, because the UI can only
 * offer what the generator enumerated (spec §13).
 *
 * State-based actions run after the action and after any resolutions or phase
 * changes it caused. They are idempotent, so the sweeps already done inside
 * {@link resolveTop} and {@link advancePhase} make this one free.
 *
 * Last of all the position settles: {@link settlePriority} passes through
 * every stop where the player with priority has nothing to decide (spec §9.4),
 * so the state this returns is always one somebody has a reason to look at —
 * a real choice, a pending scry, a mulligan, or a winner.
 */
export function reduce(state: GameState, action: Action): ReduceResult {
  if (!isLegal(state, action)) {
    throw new Error(`reduce: ${JSON.stringify(action)} is not a legal action in this state`);
  }

  const applied = dispatch(state, action);
  const swept = stateBasedActions(applied.state);
  const settled = settlePriority(swept.state);
  return {
    state: settled.state,
    events: [...applied.events, ...swept.events, ...settled.events],
  };
}
