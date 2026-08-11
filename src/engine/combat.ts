/**
 * Combat: declaring attackers and blockers, and the two damage steps.
 *
 * This is where the keywords stop being words and start being arithmetic.
 * Everything in spec §6 lives here, and nothing else does — phases, priority,
 * and the end-of-combat cleanup belong to `rules.ts`, so nothing in this file
 * reads or writes `state.phase`. A caller that hands us a state declares that
 * the declaration is happening now.
 *
 * Four rules hold throughout:
 *
 * 1. **Pure.** No DOM, no clock, no `Math.random`. Every function takes a
 *    `GameState` and returns `{ state, events }` — never a `ReduceResult` in.
 * 2. **The input state is never touched.** Everything clones through
 *    `cloneState` (or through `applyEffect`, which clones itself) and mutates
 *    only the copy it owns.
 * 3. **An illegal declaration throws.** `legalActions` in `actions.ts` is the
 *    single definition of legal, so reaching an illegal attack or block here
 *    means the generator and the engine have drifted: that is an engine bug and
 *    spec §13 says engine bugs are loud. It is never user error, because the UI
 *    can only offer what the generator enumerated.
 * 4. **Damage is computed against a snapshot, then applied.** All damage in a
 *    step is simultaneous, so every assignment is worked out from the state as
 *    it stood at the start of the step and only then marked. Nothing a creature
 *    takes in a step can change what it deals in that same step.
 *
 * The state-based actions applied between the two damage steps are deliberately
 * narrow: creatures die, and that is all. Player loss, empty libraries, and the
 * rest of spec §8 belong with the other loss conditions in `rules.ts`. What
 * combat cannot do without is the creature half, because "a creature killed by
 * first strike deals no damage back" is the entire point of the keyword.
 */

import type {
  BlockAssignment,
  CardId,
  GameEvent,
  GameState,
  PlayerId,
  ReduceResult,
  TargetFilter,
  Trigger,
  TriggerEvent,
} from './types';
import { STACK_CAP } from './types';
import {
  cloneState,
  hasKeyword,
  inst,
  isCreature,
  opponentOf,
  powerOf,
  toughnessOf,
} from './state';
import { applyEffect } from './effects';
import { evAttack, evBlock, evTap, evTrigger } from './events';

/**
 * The `EffectTarget` used when this file hands `applyEffect` a selection it has
 * already decided on. A `TargetFilter` target means "use the selection", and the
 * filter's own fields are never consulted — legality was settled here.
 */
const SELECTED: TargetFilter = {};

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** The triggers printed on a card, or none for a token with no definition. */
function triggersOf(state: GameState, card: CardId): readonly Trigger[] {
  const instance = state.cards[card];
  if (!instance) return [];
  return state.defs[instance.oracleId]?.triggers ?? [];
}

/**
 * Fire one card's triggers for an event, on a state this caller owns.
 *
 * The same two suppressions as everywhere else: a trigger may not enqueue a
 * trigger (spec §5), and the stack is capped at `STACK_CAP` objects (spec §3).
 * The `TRIGGER` event is emitted either way, because the log should show that an
 * ability triggered even when it could not go on the stack.
 *
 * `triggers` is passed in rather than looked up so a creature that has already
 * died can still fire on the damage it dealt on the way out.
 */
function fireTriggers(
  owned: GameState,
  events: GameEvent[],
  triggers: readonly Trigger[],
  on: TriggerEvent,
  source: CardId,
  controller: PlayerId,
): void {
  for (const trigger of triggers) {
    if (trigger.on !== on) continue;
    events.push(evTrigger(source, on));
    if (owned.resolvingTrigger) continue;
    if (owned.stack.length >= STACK_CAP) continue;
    owned.stack.push({
      id: `trigger#${owned.nextId}`,
      source,
      controller,
      effects: [...trigger.effects],
      targets: null,
      isTriggered: true,
    });
    owned.nextId += 1;
  }
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/**
 * Why this creature may not attack, or `null` when it may.
 *
 * Kept as a reason rather than a boolean so the throw from `declareAttackers`
 * says what actually went wrong — an engine bug that reports "you0 cannot
 * attack" is a bug hunt, and one that reports "was summoned this turn and has no
 * haste" is a fix.
 */
function attackProblem(state: GameState, card: CardId): string | null {
  const instance = state.cards[card];
  if (!instance) return 'is not a card in this game';
  if (instance.zone !== 'battlefield') return `is in the ${instance.zone}, not on the battlefield`;
  if (!isCreature(state, card)) return 'is not a creature';
  if (instance.controller !== state.active) return 'is not controlled by the active player';
  if (instance.tapped) return 'is tapped';
  if (hasKeyword(state, card, 'defender')) return 'has defender';
  if (instance.summonedThisTurn && !hasKeyword(state, card, 'haste')) {
    return 'was summoned this turn and does not have haste';
  }
  return null;
}

/**
 * May this creature be declared as an attacker right now?
 *
 * Untapped, a creature, controlled by the active player, not a defender, and
 * either settled since before this turn or hasty.
 */
export function canAttack(state: GameState, card: CardId): boolean {
  return attackProblem(state, card) === null;
}

/**
 * Why this creature may not block that attacker, or `null` when it may.
 *
 * Menace is deliberately absent: it is a property of the whole assignment, not
 * of any one blocker, so `declareBlockers` checks it across the set. A blocker
 * that fails here fails on its own merits.
 */
function blockProblem(state: GameState, blocker: CardId, attacker: CardId): string | null {
  const instance = state.cards[blocker];
  if (!instance) return 'is not a card in this game';
  if (instance.zone !== 'battlefield') return `is in the ${instance.zone}, not on the battlefield`;
  if (!isCreature(state, blocker)) return 'is not a creature';
  if (instance.controller !== opponentOf(state.active)) {
    return 'is not controlled by the defending player';
  }
  if (instance.tapped) return 'is tapped';
  if (instance.blocking !== undefined) return `is already blocking "${instance.blocking}"`;

  const target = state.cards[attacker];
  if (!target) return `cannot block "${attacker}", which is not a card in this game`;
  if (target.zone !== 'battlefield' || !target.attacking) {
    return `cannot block "${attacker}", which is not attacking`;
  }

  if (
    hasKeyword(state, attacker, 'flying') &&
    !hasKeyword(state, blocker, 'flying') &&
    !hasKeyword(state, blocker, 'reach')
  ) {
    return `cannot block "${attacker}", which has flying, without flying or reach`;
  }
  return null;
}

/**
 * May this creature block that attacker, considered on its own?
 *
 * Everything a single blocker can settle: it is an untapped creature the
 * defending player controls, it is not already committed to a block, the
 * attacker really is attacking, and flying is beaten by flying or reach. Menace
 * is a constraint on the whole set of blocks and is checked by
 * {@link declareBlockers}.
 */
export function canBlock(state: GameState, blocker: CardId, attacker: CardId): boolean {
  return blockProblem(state, blocker, attacker) === null;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * Declare attackers: tap the ones without vigilance, mark them attacking, and
 * fire `onAttack`.
 *
 * Every attacker is validated against the state as it was handed in, before
 * anything is written, so an illegal declaration leaves nothing half-applied.
 * Declaring nobody is a legal declaration and is silent — no `ATTACK` event for
 * an attack that did not happen.
 */
export function declareAttackers(state: GameState, attackers: CardId[]): ReduceResult {
  const seen = new Set<CardId>();
  for (const card of attackers) {
    if (seen.has(card)) throw new Error(`declareAttackers: "${card}" was declared twice`);
    seen.add(card);
    const problem = attackProblem(state, card);
    if (problem) throw new Error(`declareAttackers: "${card}" cannot attack — it ${problem}`);
  }

  const next = cloneState(state);
  const events: GameEvent[] = [];
  if (attackers.length === 0) return { state: next, events };

  events.push(evAttack(attackers));
  for (const card of attackers) {
    const instance = next.cards[card]!;
    instance.attacking = true;
    if (hasKeyword(next, card, 'vigilance')) continue;
    instance.tapped = true;
    events.push(evTap(card));
  }

  for (const card of attackers) {
    fireTriggers(next, events, triggersOf(next, card), 'onAttack', card, next.cards[card]!.controller);
  }
  return { state: next, events };
}

/**
 * Are the menace attackers in this assignment blocked by enough creatures?
 *
 * Menace is the one piece of evasion a blocker cannot beat alone, so it can only
 * be judged across the whole declaration: one blocker on a menacing attacker is
 * illegal, none is fine, two or more is fine. Checking it per blocker would let
 * a single block through whenever it was validated on its own.
 */
function menaceProblem(state: GameState, blocks: readonly BlockAssignment[]): string | null {
  const counts = new Map<CardId, number>();
  for (const block of blocks) {
    counts.set(block.attacker, (counts.get(block.attacker) ?? 0) + 1);
  }
  for (const [attacker, count] of counts) {
    if (count !== 1) continue;
    if (!hasKeyword(state, attacker, 'menace')) continue;
    return `"${attacker}" has menace and cannot be blocked by exactly one creature`;
  }
  return null;
}

/**
 * Declare blockers: point each blocker at its attacker, record the assignment
 * order on the attacker, and fire `onBlock`.
 *
 * `blockedBy` keeps the order the blocks arrived in, because that is the
 * defender's damage assignment order and the whole of `resolveDamageStep` walks
 * it. Reordering it later is what the `orderBlockers` action is for.
 *
 * `onBlock` fires on the blocker only. The pool reads it as "whenever this
 * creature blocks" (Netcaster Spider), and `TriggerEvent` has no separate
 * "becomes blocked", so firing it on the attacker as well would make every
 * blocking trigger misfire on offense.
 */
export function declareBlockers(state: GameState, blocks: BlockAssignment[]): ReduceResult {
  const seen = new Set<CardId>();
  for (const block of blocks) {
    if (seen.has(block.blocker)) {
      throw new Error(`declareBlockers: "${block.blocker}" was assigned to two attackers`);
    }
    seen.add(block.blocker);
    const problem = blockProblem(state, block.blocker, block.attacker);
    if (problem) throw new Error(`declareBlockers: "${block.blocker}" ${problem}`);
  }

  const menace = menaceProblem(state, blocks);
  if (menace) throw new Error(`declareBlockers: ${menace}`);

  const next = cloneState(state);
  const events: GameEvent[] = [];
  for (const block of blocks) {
    next.cards[block.blocker]!.blocking = block.attacker;
    next.cards[block.attacker]!.blockedBy.push(block.blocker);
    events.push(evBlock(block.blocker, block.attacker));
  }

  for (const block of blocks) {
    const controller = next.cards[block.blocker]!.controller;
    fireTriggers(next, events, triggersOf(next, block.blocker), 'onBlock', block.blocker, controller);
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// Damage assignment
// ---------------------------------------------------------------------------

/**
 * One creature's damage for one step, worked out but not yet dealt.
 *
 * Splitting the arithmetic from the marking is what makes a damage step
 * simultaneous: every plan is built against the same snapshot, so a creature
 * cannot shrink, die, or gain a keyword partway through a step it is part of.
 */
interface DamagePlan {
  source: CardId;
  controller: PlayerId;
  /** The player any trample or unblocked damage goes to. */
  defender: PlayerId;
  toCards: Array<{ card: CardId; amount: number }>;
  toPlayer: number;
  /** Whether this source's damage is lethal in any amount. */
  deathtouch: boolean;
}

function planTotal(plan: DamagePlan): number {
  return plan.toCards.reduce((sum, bit) => sum + bit.amount, 0) + plan.toPlayer;
}

/** Every creature currently attacking, in a stable order. */
function attackersIn(state: GameState): CardId[] {
  const out: CardId[] = [];
  for (const player of state.players) {
    for (const id of player.battlefield) {
      if (state.cards[id]?.attacking) out.push(id);
    }
  }
  return out;
}

/** Every creature currently blocking something, in a stable order. */
function blockersIn(state: GameState): CardId[] {
  const out: CardId[] = [];
  for (const player of state.players) {
    for (const id of player.battlefield) {
      if (state.cards[id]?.blocking !== undefined) out.push(id);
    }
  }
  return out;
}

/** Is this blocker still on the battlefield and still blocking that attacker? */
function stillBlocking(state: GameState, blocker: CardId, attacker: CardId): boolean {
  const instance = state.cards[blocker];
  return instance !== undefined && instance.zone === 'battlefield' && instance.blocking === attacker;
}

/**
 * How much damage counts as lethal for this blocker right now: its remaining
 * toughness, or one point from a source with deathtouch. Damage already marked
 * counts, so a creature that survived the first-strike step is that much easier
 * to finish in the regular one.
 */
function lethalFor(state: GameState, blocker: CardId, deathtouch: boolean): number {
  if (deathtouch) return 1;
  return Math.max(0, toughnessOf(state, blocker) - inst(state, blocker).damage);
}

/**
 * What one attacker deals this step.
 *
 * Unblocked, it all goes to the defending player. Blocked, it walks `blockedBy`
 * in the defender's order and assigns lethal to each blocker before moving on.
 * What is left over then goes:
 *
 * - to the defending player, if the attacker has trample — that is the keyword;
 * - otherwise onto the last blocker it assigned to. An attacker must assign all
 *   of its damage somewhere, and without trample the only somewhere is a
 *   creature. This is invisible to who lives and who dies, and visible to
 *   lifelink, which counts every point dealt.
 *
 * A blocker that has already left combat is skipped, but the attacker stays
 * blocked: `isBlocked` is measured before the first damage step, so an attacker
 * whose only blocker died to first strike still deals nothing to the player
 * unless it has trample.
 */
function planAttacker(state: GameState, attacker: CardId, isBlocked: boolean): DamagePlan {
  const instance = inst(state, attacker);
  const deathtouch = hasKeyword(state, attacker, 'deathtouch');
  const plan: DamagePlan = {
    source: attacker,
    controller: instance.controller,
    defender: opponentOf(instance.controller),
    toCards: [],
    toPlayer: 0,
    deathtouch,
  };

  let remaining = Math.max(0, powerOf(state, attacker));
  if (remaining === 0) return plan;

  if (!isBlocked) {
    plan.toPlayer = remaining;
    return plan;
  }

  const live = instance.blockedBy.filter((blocker) => stillBlocking(state, blocker, attacker));
  for (const blocker of live) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, lethalFor(state, blocker, deathtouch));
    if (amount <= 0) continue;
    plan.toCards.push({ card: blocker, amount });
    remaining -= amount;
  }

  if (remaining <= 0) return plan;
  if (hasKeyword(state, attacker, 'trample')) {
    plan.toPlayer = remaining;
  } else if (plan.toCards.length > 0) {
    plan.toCards[plan.toCards.length - 1]!.amount += remaining;
  } else if (live.length > 0) {
    plan.toCards.push({ card: live[live.length - 1]!, amount: remaining });
  }
  return plan;
}

/**
 * What one blocker deals this step: its full power to the attacker it blocks.
 *
 * `null` when there is nothing to deal it to — the attacker died in the
 * first-strike step, or left combat some other way. A blocker never damages a
 * player.
 */
function planBlocker(state: GameState, blocker: CardId): DamagePlan | null {
  const instance = inst(state, blocker);
  const attacker = instance.blocking;
  if (attacker === undefined) return null;

  const target = state.cards[attacker];
  if (!target || target.zone !== 'battlefield') return null;

  const power = Math.max(0, powerOf(state, blocker));
  return {
    source: blocker,
    controller: instance.controller,
    defender: opponentOf(instance.controller),
    toCards: power > 0 ? [{ card: attacker, amount: power }] : [],
    toPlayer: 0,
    deathtouch: hasKeyword(state, blocker, 'deathtouch'),
  };
}

// ---------------------------------------------------------------------------
// State-based actions
// ---------------------------------------------------------------------------

/**
 * Put every creature that should be dead into its owner's graveyard.
 *
 * Three ways to die, per spec §8 plus the keyword: toughness at zero or below,
 * damage marked at or past toughness, or any damage at all from a source with
 * deathtouch this step. Death goes through the `destroy` effect so there is one
 * death path in the engine — `DIE`, `ZONE_CHANGE`, and `onDies` all come out of
 * `effects.ts` exactly as they do for a removal spell.
 *
 * The loop repeats because a death can cause a death: a lord dying shrinks
 * everything it was pumping. It terminates because every pass removes at least
 * one creature from the battlefield.
 *
 * Only creatures are handled. Player loss and the rest of §8 belong to
 * `rules.ts`, which applies them after every resolution — including this one.
 */
function applyStateBasedActions(state: GameState, deathtouched: ReadonlySet<CardId>): ReduceResult {
  let next = state;
  const events: GameEvent[] = [];

  for (;;) {
    const doomed: CardId[] = [];
    for (const player of next.players) {
      for (const id of player.battlefield) {
        const card = next.cards[id];
        if (!card || !isCreature(next, id)) continue;
        const toughness = toughnessOf(next, id);
        if (toughness <= 0) {
          doomed.push(id);
        } else if (card.damage > 0 && (card.damage >= toughness || deathtouched.has(id))) {
          doomed.push(id);
        }
      }
    }
    if (doomed.length === 0) return { state: next, events };

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
  }
}

// ---------------------------------------------------------------------------
// The damage steps
// ---------------------------------------------------------------------------

/** Does this creature deal its damage in the first-strike step? */
function strikesFirst(state: GameState, card: CardId): boolean {
  return hasKeyword(state, card, 'first strike') || hasKeyword(state, card, 'double strike');
}

/** Does it deal damage in the regular step? Everyone but a pure first striker. */
function strikesRegular(state: GameState, card: CardId): boolean {
  return hasKeyword(state, card, 'double strike') || !hasKeyword(state, card, 'first strike');
}

/**
 * One damage step, start to finish.
 *
 * Plans are built against the state as it stands, then applied together, then
 * lifelink is paid, then the dead are swept up, and only then does
 * `onDealCombatDamage` fire — a creature that dealt damage on its way out still
 * triggers, which is why its definition is captured before the sweep.
 *
 * Lifelink is paid on the total this source dealt in this step, blockers and
 * player together, and it is paid here rather than in `effects.ts` so it cannot
 * be counted twice.
 *
 * `state` must be a state this caller owns; it is mutated in place when triggers
 * are enqueued.
 */
function runDamageStep(
  state: GameState,
  dealsNow: (state: GameState, card: CardId) => boolean,
  blockedAtStart: ReadonlySet<CardId>,
): ReduceResult {
  const plans: DamagePlan[] = [];
  for (const attacker of attackersIn(state)) {
    if (!dealsNow(state, attacker)) continue;
    plans.push(planAttacker(state, attacker, blockedAtStart.has(attacker)));
  }
  for (const blocker of blockersIn(state)) {
    if (!dealsNow(state, blocker)) continue;
    const plan = planBlocker(state, blocker);
    if (plan) plans.push(plan);
  }

  const dealing = plans.filter((plan) => planTotal(plan) > 0);
  if (dealing.length === 0) return { state, events: [] };

  let next = state;
  const events: GameEvent[] = [];
  const deathtouched = new Set<CardId>();

  for (const plan of dealing) {
    for (const bit of plan.toCards) {
      const result = applyEffect(
        next,
        { kind: 'damage', target: SELECTED, amount: bit.amount },
        plan.source,
        plan.controller,
        [bit.card],
      );
      next = result.state;
      events.push(...result.events);
      if (plan.deathtouch) deathtouched.add(bit.card);
    }
    if (plan.toPlayer > 0) {
      const result = applyEffect(
        next,
        { kind: 'damage', target: 'player', amount: plan.toPlayer },
        plan.source,
        plan.controller,
        plan.defender === 0 ? 'player0' : 'player1',
      );
      next = result.state;
      events.push(...result.events);
    }
  }

  for (const plan of dealing) {
    if (!hasKeyword(next, plan.source, 'lifelink')) continue;
    const result = applyEffect(
      next,
      { kind: 'gainLife', player: 'you', amount: planTotal(plan) },
      plan.source,
      plan.controller,
      null,
    );
    next = result.state;
    events.push(...result.events);
  }

  // Captured before the sweep: a creature that dies to the damage it was dealt
  // still triggers on the damage it dealt, and a dying token stops existing.
  const dealt = dealing.map((plan) => ({
    source: plan.source,
    controller: plan.controller,
    triggers: triggersOf(next, plan.source),
  }));

  const swept = applyStateBasedActions(next, deathtouched);
  next = swept.state;
  events.push(...swept.events);

  for (const entry of dealt) {
    fireTriggers(next, events, entry.triggers, 'onDealCombatDamage', entry.source, entry.controller);
  }
  return { state: next, events };
}

/**
 * Resolve combat damage: the first-strike step, then the regular step.
 *
 * The first-strike step runs at all only when some creature in combat has first
 * strike or double strike — spec §6.5. State-based actions run at the end of
 * each step, which is what makes first strike mean anything: a blocker killed in
 * the first step is not around to deal damage in the second.
 *
 * Which creature deals damage when:
 *
 * - first strike — the first step only;
 * - double strike — both steps, at full power in each;
 * - anything else — the regular step only.
 *
 * Who counts as blocked is measured once, before any damage, and reused for both
 * steps. An attacker whose blockers all died to first strike is still a blocked
 * attacker and still deals nothing to the defending player without trample.
 */
export function resolveDamageStep(state: GameState): ReduceResult {
  const blockedAtStart = new Set<CardId>(
    attackersIn(state).filter((attacker) => inst(state, attacker).blockedBy.length > 0),
  );
  const inCombat = [...attackersIn(state), ...blockersIn(state)];

  let next = cloneState(state);
  const events: GameEvent[] = [];

  if (inCombat.some((card) => strikesFirst(state, card))) {
    const first = runDamageStep(next, strikesFirst, blockedAtStart);
    next = first.state;
    events.push(...first.events);
  }

  const regular = runDamageStep(next, strikesRegular, blockedAtStart);
  return { state: regular.state, events: [...events, ...regular.events] };
}
