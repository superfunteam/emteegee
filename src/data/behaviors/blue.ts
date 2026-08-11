/**
 * Blue card behaviors.
 *
 * Blue's share of the pool is fliers, bounce, counterspells and card selection.
 * Every entry below reproduces its card's oracle text exactly in the closed
 * vocabulary from engine/types.ts. Cards whose text needs something the
 * vocabulary does not have (blocking restrictions, damage prevention, "doesn't
 * untap", library reordering, animating a land) are not here — they are reported
 * for removal from the pool instead, because a near-miss behavior is a lie about
 * what the engine will do.
 *
 * Conventions used here:
 *   - Printed keywords (flying, defender, vigilance) come from Scryfall and need
 *     no entry, so the vanilla fliers are absent.
 *   - `targets` is the player's choose-at-cast-time list and is only set on
 *     spells and activated abilities. A triggered ability's target comes from
 *     the filter on its own effect, since `Trigger` carries no `targets` field.
 */

import type { BehaviorTable } from './shared';
import { ANY_CREATURE } from './shared';
import type { TargetFilter } from '../../engine/types';

/** Any spell on the stack, either player's. */
const ANY_SPELL: TargetFilter = { zone: 'stack', controller: 'any' };

/** A creature spell on the stack. */
const CREATURE_SPELL: TargetFilter = { zone: 'stack', controller: 'any', cardTypes: ['creature'] };

/**
 * A noncreature spell on the stack.
 *
 * `TargetFilter` has no negation, so "noncreature" is written as the set of
 * spell types this pool actually contains. The pool has no artifacts at all and
 * therefore no artifact creatures, so no card can match both this filter and
 * `CREATURE_SPELL` — the enumeration is exact here, not an approximation.
 * Lands never use the stack (they are played, not cast) so 'land' is omitted.
 */
const NONCREATURE_SPELL: TargetFilter = {
  zone: 'stack',
  controller: 'any',
  cardTypes: ['instant', 'sorcery', 'enchantment', 'artifact'],
};

export const BLUE: BehaviorTable = {
  // --- Counterspells -------------------------------------------------------

  // "Counter target spell."
  'counterspell': {
    spellEffects: [{ kind: 'counterSpell' }],
    targets: [ANY_SPELL],
  },

  // "Counter target creature spell."
  'essence-scatter': {
    spellEffects: [{ kind: 'counterSpell' }],
    targets: [CREATURE_SPELL],
  },

  // "Counter target noncreature spell."
  'negate': {
    spellEffects: [{ kind: 'counterSpell' }],
    targets: [NONCREATURE_SPELL],
  },

  // --- Card draw and selection ---------------------------------------------

  // "Draw two cards."
  'divination': {
    spellEffects: [{ kind: 'draw', player: 'you', count: 2 }],
  },

  // "Scry 1. Draw a card."
  'opt': {
    spellEffects: [
      { kind: 'scry', count: 1 },
      { kind: 'draw', player: 'you', count: 1 },
    ],
  },

  // "Scry 2, then draw a card."
  'preordain': {
    spellEffects: [
      { kind: 'scry', count: 2 },
      { kind: 'draw', player: 'you', count: 1 },
    ],
  },

  // "Flying / When this creature enters, draw a card."
  'cloudkin-seer': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'draw', player: 'you', count: 1 }] },
    ],
  },

  // "{T}: Draw a card, then discard a card."
  'merfolk-looter': {
    activated: [
      {
        cost: { tapSelf: true },
        effects: [
          { kind: 'draw', player: 'you', count: 1 },
          { kind: 'discard', player: 'you', count: 1 },
        ],
        sorcerySpeed: false,
        targets: [],
      },
    ],
  },

  // --- Bounce ---------------------------------------------------------------

  // "Return target creature to its owner's hand."
  'unsummon': {
    spellEffects: [{ kind: 'returnToHand', target: ANY_CREATURE }],
    targets: [ANY_CREATURE],
  },

  // "When this creature enters, return target creature to its owner's hand."
  'man-o-war': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'returnToHand', target: ANY_CREATURE }] },
    ],
  },

  // "Flying / When this creature enters, return target creature to its owner's hand."
  'mist-raven': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'returnToHand', target: ANY_CREATURE }] },
    ],
  },

  // --- Drawbacks ------------------------------------------------------------

  /*
   * Serendib Efreet: "Flying / At the beginning of your upkeep, this creature
   * deals 1 damage to you."
   *
   * Written as `loseLife` rather than `damage`, deliberately. `damage`'s only
   * player-facing target is `'player'`, which means *the player this ability
   * targets* — and this ability targets nobody, it always hits its controller.
   * Using it would let the controller point the drawback at the opponent, which
   * inverts the card. `loseLife` with `player: 'you'` is unambiguous and, in
   * this vocabulary, indistinguishable in outcome: there is no damage
   * prevention, no damage-triggered ability, and no card in the pool that can
   * give this creature lifelink, so one damage to you and one life lost by you
   * move the game to exactly the same state.
   */
  'serendib-efreet': {
    triggers: [
      { on: 'onUpkeep', effects: [{ kind: 'loseLife', player: 'you', amount: 1 }] },
    ],
  },
};
