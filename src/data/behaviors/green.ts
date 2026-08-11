/**
 * Green card behaviors.
 *
 * Green in this pool is mana acceleration, combat tricks and large vanilla bodies.
 * Only the cards whose text the closed vocabulary can express exactly appear here;
 * anything needing a conditional static, a conditional trigger or an untap
 * restriction was removed from the pool instead of approximated.
 *
 * Cards deliberately absent, and why:
 *   Bramblewood Paragon  replacement effect ("enters with an additional +1/+1
 *                        counter") plus a keyword granted by counter state.
 *   Netcaster Spider     "whenever this blocks a creature with flying" — onBlock
 *                        carries no condition on what was blocked.
 *   Nettle Sentinel      "doesn't untap during your untap step" has no vocabulary
 *                        member, and the untap trigger is optional and color-gated.
 */

import type { BehaviorTable } from './shared';
import { ANY_CREATURE, YOUR_CREATURE, manaDork } from './shared';

export const GREEN: BehaviorTable = {

  // Mana creatures — {T}: Add {G}.
  'llanowar-elves': {
    activated: [manaDork('G')],
  },
  'elvish-mystic': {
    activated: [manaDork('G')],
  },
  // Defender is printed on the card, so Scryfall supplies the keyword.
  'vine-trellis': {
    activated: [manaDork('G')],
  },

  // Combat tricks.
  // "Target creature gets +3/+3 until end of turn."
  'giant-growth': {
    targets: [ANY_CREATURE],
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 3, toughness: 3, duration: 'endOfTurn' },
    ],
  },

  // "Target creature gets +4/+4 until end of turn."
  'titanic-growth': {
    targets: [ANY_CREATURE],
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 4, toughness: 4, duration: 'endOfTurn' },
    ],
  },

  // "Target creature gets +1/+1 until end of turn. Draw a card."
  'aggressive-urge': {
    targets: [ANY_CREATURE],
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 1, toughness: 1, duration: 'endOfTurn' },
      { kind: 'draw', player: 'you', count: 1 },
    ],
  },

  // "Target creature gets +2/+2 and gains trample until end of turn. Draw a card."
  'wildsize': {
    targets: [ANY_CREATURE],
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 2, toughness: 2, duration: 'endOfTurn' },
      { kind: 'grantKeyword', target: ANY_CREATURE, keyword: 'trample', duration: 'endOfTurn' },
      { kind: 'draw', player: 'you', count: 1 },
    ],
  },

  // "Creatures you control get +3/+3 and gain trample until end of turn."
  // Untargeted: the filter itself selects every creature you control.
  'overrun': {
    spellEffects: [
      { kind: 'pump', target: YOUR_CREATURE, power: 3, toughness: 3, duration: 'endOfTurn' },
      { kind: 'grantKeyword', target: YOUR_CREATURE, keyword: 'trample', duration: 'endOfTurn' },
    ],
  },

  // Fatties with text.
  // "When this creature enters, you gain 7 life. When this creature dies, draw a card."
  // Trample is printed, so Scryfall supplies the keyword.
  'pelakka-wurm': {
    triggers: [
      { on: 'onEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 7 }] },
      { on: 'onDies', effects: [{ kind: 'draw', player: 'you', count: 1 }] },
    ],
  },
};
