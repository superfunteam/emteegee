/**
 * `GameEvent` constructors.
 *
 * The engine narrates itself through events: every mutator returns the events it
 * caused, the animator plays them on a timeline, and the audio kit maps them to
 * samples. This file exists so those shapes are built in exactly one place — a
 * literal typed inline somewhere in `combat.ts` is a shape the compiler checks
 * but nobody can find again.
 *
 * There is no logic here and there never should be. Each function is the
 * `GameEvent` variant it names.
 */

import type {
  CardId,
  CounterKind,
  GameEvent,
  Phase,
  PlayerId,
  TargetSelection,
  TriggerEvent,
  Zone,
} from './types';

/** A card left the library for a hand. */
export const evDraw = (player: PlayerId, card: CardId): GameEvent => ({ type: 'DRAW', player, card });

/** A land was played. Lands do not use the stack, so they are played, not cast. */
export const evPlay = (player: PlayerId, card: CardId): GameEvent => ({ type: 'PLAY', player, card });

/** A spell went on the stack. */
export const evCast = (player: PlayerId, card: CardId, targets: TargetSelection): GameEvent => ({
  type: 'CAST',
  player,
  card,
  targets,
});

/** A stack object resolved. */
export const evResolve = (card: CardId): GameEvent => ({ type: 'RESOLVE', card });

/** A stack object was removed without resolving. */
export const evCountered = (card: CardId): GameEvent => ({ type: 'COUNTERED', card });

export const evTap = (card: CardId): GameEvent => ({ type: 'TAP', card });

export const evUntap = (card: CardId): GameEvent => ({ type: 'UNTAP', card });

/** Attackers are declared as one event, so the animator can lunge them together. */
export const evAttack = (attackers: CardId[]): GameEvent => ({ type: 'ATTACK', attackers: [...attackers] });

export const evBlock = (blocker: CardId, attacker: CardId): GameEvent => ({ type: 'BLOCK', blocker, attacker });

/** Damage marked on a permanent. Marking damage never removes it — see `effects.ts`. */
export const evDamage = (source: CardId, target: CardId, amount: number): GameEvent => ({
  type: 'DAMAGE',
  source,
  target,
  amount,
  isPlayer: false,
});

/** Damage dealt to a player. The life total change follows as its own event. */
export const evDamagePlayer = (source: CardId, target: PlayerId, amount: number): GameEvent => ({
  type: 'DAMAGE',
  source,
  target,
  amount,
  isPlayer: true,
});

/** A creature was put into a graveyard from the battlefield. */
export const evDie = (card: CardId): GameEvent => ({ type: 'DIE', card });

/** Every life total change carries both totals, so the UI can animate the delta. */
export const evLifeChange = (player: PlayerId, from: number, to: number): GameEvent => ({
  type: 'LIFE_CHANGE',
  player,
  from,
  to,
});

export const evCounterAdd = (card: CardId, counter: CounterKind, count: number): GameEvent => ({
  type: 'COUNTER_ADD',
  card,
  counter,
  count,
});

export const evTokenCreate = (card: CardId): GameEvent => ({ type: 'TOKEN_CREATE', card });

export const evZoneChange = (card: CardId, from: Zone, to: Zone): GameEvent => ({
  type: 'ZONE_CHANGE',
  card,
  from,
  to,
});

/** A scry was set up. The cards themselves wait on `GameState.pendingScry`. */
export const evScry = (player: PlayerId, count: number): GameEvent => ({ type: 'SCRY', player, count });

export const evPhase = (phase: Phase, active: PlayerId, turn: number): GameEvent => ({
  type: 'PHASE',
  phase,
  active,
  turn,
});

/** An ability triggered. Emitted whether or not it made it onto the stack. */
export const evTrigger = (source: CardId, on: TriggerEvent): GameEvent => ({ type: 'TRIGGER', source, on });

export const evWin = (player: PlayerId): GameEvent => ({ type: 'WIN', player });
