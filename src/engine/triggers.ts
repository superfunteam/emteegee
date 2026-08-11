/**
 * Putting a triggered ability on the stack.
 *
 * `effects.ts`, `combat.ts` and `rules.ts` each cause triggers — a creature
 * dying, a blocker being declared, a permanent arriving — and each used to carry
 * its own copy of this loop. One copy means the two suppressions and the target
 * choice cannot drift between them.
 *
 * Two rules hold for every trigger, wherever it comes from:
 *
 * 1. **The `TRIGGER` event is emitted unconditionally.** The log and the
 *    animator should show that an ability triggered even when it could not go on
 *    the stack. Only the enqueue is ever suppressed.
 * 2. **The enqueue is suppressed in exactly two cases** — while
 *    `state.resolvingTrigger` is set, because a trigger may not enqueue a
 *    trigger (spec §5), and at `STACK_CAP`, because the cap counts every object
 *    (spec §3).
 *
 * The triggers are handed in rather than looked up, so a creature that has
 * already died — or a token that has stopped existing — still fires the ability
 * it had on the way out.
 */

import type {
  CardDef,
  CardId,
  GameEvent,
  GameState,
  PlayerId,
  TargetFilter,
  Trigger,
  TriggerEvent,
} from './types';
import { STACK_CAP } from './types';
import { triggerTargets } from './actions';
import { evTrigger } from './events';

/**
 * What a card brings to a trigger: its triggered abilities, and the targets its
 * definition declares for the ones that do not declare their own.
 */
export interface TriggerSource {
  triggers: readonly Trigger[];
  targets: readonly TargetFilter[];
}

const NONE: TriggerSource = { triggers: [], targets: [] };

/** A definition's triggers, or nothing at all when there is no definition. */
export function triggersOfDef(definition: CardDef | undefined): TriggerSource {
  if (!definition) return NONE;
  return { triggers: definition.triggers, targets: definition.targets };
}

/**
 * The triggers printed on a card, or none for a token that has no definition.
 *
 * Read it *before* the card can leave — a dying token is deleted from
 * `state.cards`, and its abilities still have to fire.
 */
export function triggerSourceOf(state: GameState, card: CardId): TriggerSource {
  const instance = state.cards[card];
  if (!instance) return NONE;
  return triggersOfDef(state.defs[instance.oracleId]);
}

/**
 * Fire one card's triggers for an event, on a state this caller owns.
 *
 * Targets are chosen as the ability goes on the stack, which is the moment Magic
 * chooses them and a different moment than the spell that created the ability
 * chose its own. A trigger that declares `targets` of its own wins; otherwise
 * the card's `CardDef.targets` are used, which is what lets "when this creature
 * dies, it deals 2 damage to target creature" keep pointing somewhere without
 * every trigger having to restate the filter.
 */
export function fireTriggers(
  owned: GameState,
  events: GameEvent[],
  from: TriggerSource,
  on: TriggerEvent,
  card: CardId,
  controller: PlayerId,
): void {
  for (const trigger of from.triggers) {
    if (trigger.on !== on) continue;
    events.push(evTrigger(card, on));
    if (owned.resolvingTrigger) continue;
    if (owned.stack.length >= STACK_CAP) continue;
    owned.stack.push({
      id: `trigger#${owned.nextId}`,
      source: card,
      controller,
      effects: [...trigger.effects],
      targets: triggerTargets(owned, trigger.targets ?? from.targets, controller),
      isTriggered: true,
    });
    owned.nextId += 1;
  }
}
