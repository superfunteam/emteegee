/**
 * Shared shapes and shorthand for the hand-authored card behavior tables.
 *
 * Everything mechanical about a card that cannot be derived from Scryfall's structured
 * fields is expressed here in the closed effect vocabulary from engine/types.ts.
 * Vanilla creatures and basic lands need no entry.
 */

import type {
  ActivatedAbility,
  Effect,
  ManaCost,
  StaticAbility,
  TargetFilter,
  Trigger,
} from '../../engine/types';

export interface Behavior {
  statics?: StaticAbility[];
  triggers?: Trigger[];
  activated?: ActivatedAbility[];
  /** Instants and sorceries only. */
  spellEffects?: Effect[];
  /** One entry per required target, in the order the player chooses them. */
  targets?: TargetFilter[];
  wardCost?: ManaCost;
}

export type BehaviorTable = Record<string, Behavior>;

// Shorthand filters, so the tables read like the cards they describe.
export const ANY_CREATURE: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'], controller: 'any' };
export const YOUR_CREATURE: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'], controller: 'you' };
export const THEIR_CREATURE: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'], controller: 'opponent' };
export const ATTACKING_CREATURE: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'], attacking: true };
export const YOUR_ATTACKERS: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'], controller: 'you', attacking: true };

/** A creature subtype lord: "Other Goblins you control get +1/+1". */
export const tribe = (subtype: string): TargetFilter => ({
  zone: 'battlefield',
  cardTypes: ['creature'],
  controller: 'you',
  subtypes: [subtype],
});

/** `{T}: Add {G}.` and friends. */
export const manaDork = (color: 'W' | 'U' | 'B' | 'R' | 'G'): ActivatedAbility => ({
  cost: { tapSelf: true },
  effects: [{ kind: 'addMana', colors: [color] }],
  sorcerySpeed: false,
  targets: [],
});

/** Firebreathing-style pump: `{R}: This creature gets +1/+0 until end of turn.` */
export const pumpAbility = (
  mana: ManaCost,
  power: number,
  toughness: number,
): ActivatedAbility => ({
  cost: { mana },
  effects: [{ kind: 'pump', target: 'self', power, toughness, duration: 'endOfTurn' }],
  sorcerySpeed: false,
  targets: [],
});
