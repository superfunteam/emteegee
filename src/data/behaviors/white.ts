/**
 * White card behaviors.
 *
 * White in this pool is small creatures that add up, lifegain, tokens, tappers and
 * one board wipe. Every entry below is the card's real oracle text expressed exactly
 * in the closed vocabulary from engine/types.ts — nothing here is an approximation.
 *
 * Cards whose text needs something the vocabulary does not have (damage prevention,
 * conditional statics, counters other than +1/+1 and -1/-1, disjunctive target
 * filters, costs beyond mana/tap/sacrifice-self) are not listed here. They are
 * reported for removal from the pool instead, because a card in the pool is a
 * promise that the engine plays it correctly.
 */

import { ANY_CREATURE, YOUR_CREATURE, tribe, type BehaviorTable } from './shared';
import type { TargetFilter } from '../../engine/types';
import { SOLDIER_TOKEN } from '../tokens';

/**
 * "Target nonwhite creature."
 *
 * Written as a negation rather than a whitelist of the other four colors, because a
 * whitelist gets both edges wrong: a white-black creature is still white and must be
 * excluded, and a colorless creature is not white and must be allowed.
 */
const NONWHITE_CREATURE: TargetFilter = {
  zone: 'battlefield',
  cardTypes: ['creature'],
  controller: 'any',
  notColors: ['W'],
};

/**
 * "Other Soldier creatures" — every Soldier on the table, not only yours.
 *
 * `tribe('Soldier')` is the *you control* reading and would silently make Field
 * Marshal a one-sided lord, so this filter is spelled out with `controller: 'any'`.
 */
const ANY_SOLDIER: TargetFilter = {
  zone: 'battlefield',
  cardTypes: ['creature'],
  controller: 'any',
  subtypes: ['Soldier'],
};

export const WHITE: BehaviorTable = {
  // --- Lords and anthems -------------------------------------------------

  /** "Other creatures you control get +1/+1." */
  'benalish-marshal': {
    statics: [
      { kind: 'staticPump', filter: YOUR_CREATURE, power: 1, toughness: 1, excludeSelf: true },
    ],
  },

  /** "Creatures you control get +1/+1." (Enchantment, so it is never its own target.) */
  'glorious-anthem': {
    statics: [
      { kind: 'staticPump', filter: YOUR_CREATURE, power: 1, toughness: 1, excludeSelf: false },
    ],
  },

  /** "Other Soldier creatures you control get +1/+0." */
  'veteran-swordsmith': {
    statics: [
      { kind: 'staticPump', filter: tribe('Soldier'), power: 1, toughness: 0, excludeSelf: true },
    ],
  },

  /**
   * "Other Soldier creatures get +1/+1 and have first strike."
   *
   * Note the missing "you control": this lord pumps the opponent's Soldiers too, so the
   * filter is `ANY_SOLDIER`. The granted keyword rides on the same `staticPump`, which
   * is what keeps the +1/+1 and the first strike pointed at the same set of creatures.
   */
  'field-marshal': {
    statics: [
      {
        kind: 'staticPump',
        filter: ANY_SOLDIER,
        power: 1,
        toughness: 1,
        excludeSelf: true,
        keywords: ['first strike'],
      },
    ],
  },

  // --- Enters-the-battlefield triggers ------------------------------------

  /** "When this creature enters, you gain 3 life." (Flying is a printed keyword.) */
  'angel-of-mercy': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 3 }] },
    ],
  },

  /** "When this creature enters, draw a card." (Defender is a printed keyword.) */
  'wall-of-omens': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'draw', player: 'you', count: 1 }] },
    ],
  },

  /**
   * "When this creature enters, target creature gets +1/+1 until end of turn."
   *
   * The target belongs to the *trigger*, not to the creature spell. Declared at the
   * behavior level it would be demanded when the 2/2 is cast, and a Skirmisher would
   * be uncastable on an empty board; on the trigger it is chosen as the ability goes
   * on the stack, which is the moment the card means.
   */
  'kinsbaile-skirmisher': {
    triggers: [
      {
        on: 'onEnterBattlefield',
        effects: [
          { kind: 'pump', target: ANY_CREATURE, power: 1, toughness: 1, duration: 'endOfTurn' },
        ],
        targets: [ANY_CREATURE],
      },
    ],
  },

  /** "Whenever you gain life, put a +1/+1 counter on this creature." */
  'ajani-s-pridemate': {
    triggers: [
      {
        on: 'onLifeGain',
        effects: [{ kind: 'addCounter', target: 'self', counter: '+1/+1', count: 1 }],
      },
    ],
  },

  // --- Tappers ------------------------------------------------------------

  /** "{W}, {T}: Tap target creature." */
  'gideon-s-lawkeeper': {
    activated: [
      {
        cost: { mana: { W: 1 }, tapSelf: true },
        effects: [{ kind: 'tap', target: ANY_CREATURE }],
        sorcerySpeed: false,
        targets: [ANY_CREATURE],
      },
    ],
  },

  /** "{W}, {T}: Tap target creature." */
  'master-decoy': {
    activated: [
      {
        cost: { mana: { W: 1 }, tapSelf: true },
        effects: [{ kind: 'tap', target: ANY_CREATURE }],
        sorcerySpeed: false,
        targets: [ANY_CREATURE],
      },
    ],
  },

  // --- Auras --------------------------------------------------------------
  //
  // "Enchant creature" is a targeting requirement on the aura *spell*, and
  // `attachAura` reads the cast-time selection to decide what the aura lands on. So
  // every aura carries a top-level `targets` as well as its `attachTo` filter: the
  // static describes what it may enchant, the target list is what actually offers
  // the choice. Without it the aura resolves attached to nothing and is put into the
  // graveyard by state-based actions the moment it arrives.

  /** "Enchant creature. Enchanted creature gets +1/+2." */
  'holy-strength': {
    statics: [
      { kind: 'aura', attachTo: ANY_CREATURE, power: 1, toughness: 2, keywords: [] },
    ],
    targets: [ANY_CREATURE],
  },

  /** "Enchant creature. Enchanted creature gets +2/+2 and has vigilance." */
  'marked-by-honor': {
    statics: [
      { kind: 'aura', attachTo: ANY_CREATURE, power: 2, toughness: 2, keywords: ['vigilance'] },
    ],
    targets: [ANY_CREATURE],
  },

  /** "Enchant creature. Enchanted creature gets +2/+2 and has flying and vigilance." */
  'serra-s-embrace': {
    statics: [
      {
        kind: 'aura',
        attachTo: ANY_CREATURE,
        power: 2,
        toughness: 2,
        keywords: ['flying', 'vigilance'],
      },
    ],
    targets: [ANY_CREATURE],
  },

  // --- Spells -------------------------------------------------------------

  /** "Create two 1/1 white Soldier creature tokens." (Instant.) */
  'raise-the-alarm': {
    spellEffects: [{ kind: 'createToken', token: SOLDIER_TOKEN, count: 2 }],
  },

  /** "Create three 1/1 white Soldier creature tokens." (Sorcery.) */
  'captain-s-call': {
    spellEffects: [{ kind: 'createToken', token: SOLDIER_TOKEN, count: 3 }],
  },

  /** "You gain 4 life." */
  'sacred-nectar': {
    spellEffects: [{ kind: 'gainLife', player: 'you', amount: 4 }],
  },

  /**
   * "Sunlance deals 3 damage to target nonwhite creature." (Sorcery.)
   *
   * Creature-only: this is not "any target", so the effect points at a filter rather
   * than at `'any'` and a player can never be chosen.
   */
  'sunlance': {
    spellEffects: [{ kind: 'damage', target: NONWHITE_CREATURE, amount: 3 }],
    targets: [NONWHITE_CREATURE],
  },

  /** "Target creature gets +3/+3 and gains flying until end of turn." */
  'angelic-blessing': {
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 3, toughness: 3, duration: 'endOfTurn' },
      { kind: 'grantKeyword', target: ANY_CREATURE, keyword: 'flying', duration: 'endOfTurn' },
    ],
    targets: [ANY_CREATURE],
  },

  /**
   * "Destroy all creatures. They can't be regenerated."
   * Untargeted, so the filter is the whole set it hits; regeneration does not exist
   * in this game, which is why validate.ts strips that rider as inert.
   */
  /**
   * "Whenever another creature enters, you gain 1 life."
   *
   * Any creature, either side of the table — which is why this needs
   * onOtherEnterBattlefield to sweep both battlefields rather than just its own.
   */
  'soul-warden': {
    triggers: [{ on: 'onOtherEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 1 }] }],
  },

  /** "Destroy all creatures. They can't be regenerated." */
  'wrath-of-god': {
    spellEffects: [{ kind: 'destroy', target: { every: ANY_CREATURE } }],
  },
};
