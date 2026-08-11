/**
 * Red: firebreathing dragons, goblins, and what is left of the burn.
 *
 * A note on burn, because it is the biggest thing missing here. `EffectTarget` is
 * `TargetFilter | 'self' | 'player'`, and a `TargetFilter` describes permanents. There is
 * no member meaning "a creature *or* a player, the caster's choice", so "deals N damage to
 * any target" cannot be written down. Lightning Bolt, Shock, Searing Spear, Volcanic
 * Hammer, Incinerate, Mogg Fanatic, Ember Hauler and Prodigal Pyromancer are therefore not
 * in the pool: encoding them creature-only or face-only would ship a card that does not do
 * what its own printed text says. "Target player or planeswalker" is a different matter —
 * this game has no planeswalkers, so it is exactly `target: 'player'`, and Lava Axe and
 * Viashino Pyromancer carry red's reach.
 */

import type { TargetFilter } from '../../engine/types';
import { ANY_CREATURE, ATTACKING_CREATURE, pumpAbility, type BehaviorTable } from './shared';
import { GOBLIN_TOKEN } from '../tokens';

/** Torch Fiend's ability points here. Nothing in the pool matches it today. */
const ANY_ARTIFACT: TargetFilter = { zone: 'battlefield', cardTypes: ['artifact'], controller: 'any' };

export const RED: BehaviorTable = {
  // -------------------------------------------------------------------------
  // Firebreathing: "{R}: This creature gets +1/+0 until end of turn."
  // -------------------------------------------------------------------------

  'dragon-hatchling': {
    activated: [pumpAbility({ R: 1 }, 1, 0)],
  },

  'furnace-whelp': {
    activated: [pumpAbility({ R: 1 }, 1, 0)],
  },

  'shivan-dragon': {
    activated: [pumpAbility({ R: 1 }, 1, 0)],
  },

  // -------------------------------------------------------------------------
  // Other activated abilities
  // -------------------------------------------------------------------------

  /** "{R}: This creature gains flying until end of turn." */
  'goblin-balloon-brigade': {
    activated: [
      {
        cost: { mana: { R: 1 } },
        effects: [{ kind: 'grantKeyword', target: 'self', keyword: 'flying', duration: 'endOfTurn' }],
        sorcerySpeed: false,
        targets: [],
      },
    ],
  },

  /**
   * "{R}, Sacrifice this creature: Destroy target artifact."
   * The pool holds no artifacts, so the ability is legal and never offered — which is
   * exactly what the printed card does on an artifact-free table.
   */
  'torch-fiend': {
    activated: [
      {
        cost: { mana: { R: 1 }, sacrificeSelf: true },
        effects: [{ kind: 'destroy', target: ANY_ARTIFACT }],
        sorcerySpeed: false,
        targets: [ANY_ARTIFACT],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /** "When this creature dies, it deals 2 damage to target creature." */
  'bogardan-firefiend': {
    triggers: [{ on: 'onDies', effects: [{ kind: 'damage', target: ANY_CREATURE, amount: 2 }] }],
    targets: [ANY_CREATURE],
  },

  /**
   * "When this creature enters, it deals 2 damage to target player or planeswalker."
   * No planeswalkers exist here, so the clause is precisely "target player".
   */
  'viashino-pyromancer': {
    triggers: [{ on: 'onEnterBattlefield', effects: [{ kind: 'damage', target: 'player', amount: 2 }] }],
  },

  // -------------------------------------------------------------------------
  // Spells
  // -------------------------------------------------------------------------

  /** "Create two 1/1 red Goblin creature tokens." */
  'krenko-s-command': {
    spellEffects: [{ kind: 'createToken', token: GOBLIN_TOKEN, count: 2 }],
  },

  /** "Lava Axe deals 5 damage to target player or planeswalker." */
  'lava-axe': {
    spellEffects: [{ kind: 'damage', target: 'player', amount: 5 }],
  },

  /** "Attacking creatures get +2/+0 until end of turn." Every attacker, whoever controls it. */
  'trumpet-blast': {
    spellEffects: [
      { kind: 'pump', target: ATTACKING_CREATURE, power: 2, toughness: 0, duration: 'endOfTurn' },
    ],
  },
};
