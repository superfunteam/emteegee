/**
 * White card behaviors.
 *
 * White in this pool is small creatures that add up, lifegain, tokens, tappers and
 * one board wipe. Every entry below is the card's real oracle text expressed exactly
 * in the closed vocabulary from engine/types.ts — nothing here is an approximation.
 *
 * Cards whose text needs something the vocabulary does not have (damage prevention,
 * conditional statics, granting a keyword to *other* creatures, counters other than
 * +1/+1 and -1/-1, negated or disjunctive target filters) are not listed here. They
 * are reported for removal from the pool instead, because a card in the pool is a
 * promise that the engine plays it correctly.
 */

import { ANY_CREATURE, YOUR_CREATURE, tribe, type BehaviorTable } from './shared';
import { SOLDIER_TOKEN } from '../tokens';

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

  /** "When this creature enters, target creature gets +1/+1 until end of turn." */
  'kinsbaile-skirmisher': {
    triggers: [
      {
        on: 'onEnterBattlefield',
        effects: [
          { kind: 'pump', target: ANY_CREATURE, power: 1, toughness: 1, duration: 'endOfTurn' },
        ],
      },
    ],
    targets: [ANY_CREATURE],
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

  /** "Enchant creature. Enchanted creature gets +1/+2." */
  'holy-strength': {
    statics: [
      { kind: 'aura', attachTo: ANY_CREATURE, power: 1, toughness: 2, keywords: [] },
    ],
  },

  /** "Enchant creature. Enchanted creature gets +2/+2 and has vigilance." */
  'marked-by-honor': {
    statics: [
      { kind: 'aura', attachTo: ANY_CREATURE, power: 2, toughness: 2, keywords: ['vigilance'] },
    ],
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
  'wrath-of-god': {
    spellEffects: [{ kind: 'destroy', target: ANY_CREATURE }],
  },
};
