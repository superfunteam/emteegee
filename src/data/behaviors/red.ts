/**
 * Red: burn, firebreathing dragons, and goblins.
 *
 * Burn is the color's spine and the whole of it hangs on one word. "Deals N damage to any
 * target" means a creature *or* a player, chosen as the spell is cast, and that is
 * `EffectTarget`'s `'any'`. `actions.ts` enumerates both halves, so a Bolt on an empty
 * board still points at a face — which is why encoding these creature-only or face-only
 * was never an option and why they were held back until the member existed.
 *
 * A bare "any target" deliberately names no `targets` filter. An unfiltered `'any'` reads
 * as every creature on either battlefield plus both players, which is exactly the printed
 * clause; adding a filter could only narrow it.
 *
 * "Target player or planeswalker" is a different clause. This game has no planeswalkers,
 * so it is precisely `target: 'player'` — Lava Axe and Viashino Pyromancer.
 *
 * Incinerate's second sentence ("A creature dealt damage this way can't be regenerated
 * this turn") is a rider that cannot come up: nothing in the pool regenerates, the
 * vocabulary has no such mechanic, and `tools/validate.ts` already strips the sentence as
 * inert on Terror and Wrath of God for the same reason. The card plays as printed.
 *
 * Three red cards are still absent, and each for a reason the vocabulary has not moved on:
 * Bloodfire Dwarf damages *each* creature without flying — an untargeted sweep, and a
 * keyword the filter cannot negate; Firebreathing's ability pumps *enchanted* creature,
 * and no effect can point at an aura's host; Kird Ape's +1/+2 is conditional on a
 * permanent it does not name, which `staticPump` has no way to ask about.
 */

import type { TargetFilter } from '../../engine/types';
import { ANY_CREATURE, ATTACKING_CREATURE, pumpAbility, tribe, type BehaviorTable } from './shared';
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

  /**
   * "Sacrifice this creature: It deals 1 damage to any target."
   * No mana, so the whole cost is the body. The sacrifice is paid before the ability goes
   * on the stack and the ability resolves anyway, which is how Mogg Fanatic trades up.
   */
  'mogg-fanatic': {
    activated: [
      {
        cost: { sacrificeSelf: true },
        effects: [{ kind: 'damage', target: 'any', amount: 1 }],
        sorcerySpeed: false,
        targets: [],
      },
    ],
  },

  /** "{1}, Sacrifice this creature: It deals 2 damage to any target." */
  'ember-hauler': {
    activated: [
      {
        cost: { mana: { C: 1 }, sacrificeSelf: true },
        effects: [{ kind: 'damage', target: 'any', amount: 2 }],
        sorcerySpeed: false,
        targets: [],
      },
    ],
  },

  /**
   * "{T}: This creature deals 1 damage to any target."
   * A tap ability, so summoning sickness gates it exactly as it gates attacking.
   */
  'prodigal-pyromancer': {
    activated: [
      {
        cost: { tapSelf: true },
        effects: [{ kind: 'damage', target: 'any', amount: 1 }],
        sorcerySpeed: false,
        targets: [],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Statics
  // -------------------------------------------------------------------------

  /**
   * "Haste. Other Goblin creatures you control get +1/+1 and have haste."
   *
   * Its own haste is printed and comes from the pipeline. The lord half grants both the
   * pump and the keyword from one static, so the two can never disagree about which
   * Goblins they are talking about — a Goblin that got +1/+1 but not haste would be one
   * the engine refuses to let attack on the turn the printed card lets it.
   */
  'goblin-chieftain': {
    statics: [
      {
        kind: 'staticPump',
        filter: tribe('Goblin'),
        power: 1,
        toughness: 1,
        excludeSelf: true,
        keywords: ['haste'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /**
   * "When this creature dies, it deals 2 damage to target creature."
   * The target belongs to the trigger, not the card: the ability chooses where it points
   * as it goes on the stack, which is after the Firefiend is already in the graveyard.
   */
  'bogardan-firefiend': {
    triggers: [
      {
        on: 'onDies',
        effects: [{ kind: 'damage', target: ANY_CREATURE, amount: 2 }],
        targets: [ANY_CREATURE],
      },
    ],
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

  // Burn. One target, creature or face, chosen at cast time — see the note at the top of
  // the file for why none of these declares a `targets` filter.

  /** "Shock deals 2 damage to any target." */
  shock: {
    spellEffects: [{ kind: 'damage', target: 'any', amount: 2 }],
  },

  /** "Lightning Bolt deals 3 damage to any target." */
  'lightning-bolt': {
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  },

  /** "Searing Spear deals 3 damage to any target." */
  'searing-spear': {
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  },

  /** "Volcanic Hammer deals 3 damage to any target." A sorcery; the timing is its type. */
  'volcanic-hammer': {
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  },

  /**
   * "Incinerate deals 3 damage to any target. A creature dealt damage this way can't be
   * regenerated this turn."
   *
   * The second sentence is inert here — nothing in this game regenerates — so the damage
   * is the whole card.
   */
  incinerate: {
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  },

  /** "Attacking creatures get +2/+0 until end of turn." Every attacker, whoever controls it. */
  /** "Attacking creatures get +2/+0 until end of turn." All of them, both sides. */
  'trumpet-blast': {
    spellEffects: [
      { kind: 'pump', target: { every: ATTACKING_CREATURE }, power: 2, toughness: 0, duration: 'endOfTurn' },
    ],
  },
};
