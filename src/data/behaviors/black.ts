/**
 * Black card behavior.
 *
 * Only cards whose oracle text this engine can honor *exactly* appear here. Where the
 * real card needs a vocabulary member that does not exist — a sacrifice-another-creature
 * cost, an exile-self cost, damage-source tracking, or an unless-clause — the card is
 * not implemented and is reported for removal from the pool instead of being
 * approximated.
 *
 * One convention worth stating once: "target player" on a purely one-sided effect
 * (life loss, discard) is authored as `'opponent'`. In a two-player game the other
 * choice is never a choice — pointing Mind Rot at yourself is not a line anyone plays.
 * That collapse is only used where it is lossless; a card whose two target modes are
 * both real (Sign in Blood) is removed rather than silently narrowed.
 */

import type { BehaviorTable } from './shared';
import { ANY_CREATURE, pumpAbility } from './shared';
import type { TargetFilter } from '../../engine/types';

/**
 * "Target nonblack creature", black's own classic blind spot.
 *
 * Written with `notColors` rather than a whitelist of the other four colors, which
 * would be wrong twice over: a black-red creature is still black and must be spared,
 * and a colorless creature is not black and must be a legal target.
 */
const NONBLACK_CREATURE: TargetFilter = {
  zone: 'battlefield',
  cardTypes: ['creature'],
  controller: 'any',
  notColors: ['B'],
};

/** "Target nonartifact, nonblack creature" — Terror's slightly narrower reach. */
const NONBLACK_NONARTIFACT_CREATURE: TargetFilter = {
  ...NONBLACK_CREATURE,
  notCardTypes: ['artifact'],
};

export const BLACK: BehaviorTable = {

  // --- Removal ---------------------------------------------------------------

  // "Destroy target creature."
  'murder': {
    spellEffects: [{ kind: 'destroy', target: ANY_CREATURE }],
    targets: [ANY_CREATURE],
  },

  // "Destroy target nonblack creature."
  'doom-blade': {
    spellEffects: [{ kind: 'destroy', target: NONBLACK_CREATURE }],
    targets: [NONBLACK_CREATURE],
  },

  /**
   * "Destroy target nonblack creature. It can't be regenerated."
   *
   * The second sentence is inert: regeneration is out of scope for this game, so
   * nothing in the pool could ever regenerate to be stopped. `stripInertText` in
   * tools/validate.ts removes exactly this rider for exactly that reason, which makes
   * Dark Banishing and Doom Blade the same card here — as they are in play.
   */
  'dark-banishing': {
    spellEffects: [{ kind: 'destroy', target: NONBLACK_CREATURE }],
    targets: [NONBLACK_CREATURE],
  },

  // "Destroy target nonartifact, nonblack creature. It can't be regenerated."
  // The regeneration rider is inert here for the same reason it is on Dark Banishing.
  'terror': {
    spellEffects: [{ kind: 'destroy', target: NONBLACK_NONARTIFACT_CREATURE }],
    targets: [NONBLACK_NONARTIFACT_CREATURE],
  },

  // --- Disruption ------------------------------------------------------------

  // "Target player discards two cards."
  'mind-rot': {
    spellEffects: [{ kind: 'discard', player: 'opponent', count: 2 }],
  },

  // --- Drain ------------------------------------------------------------------

  // "Flying. When this creature enters, target player loses 2 life and you gain 2 life."
  // Flying comes from Scryfall's keyword list; only the trigger is authored.
  'bloodhunter-bat': {
    triggers: [{
      on: 'onEnterBattlefield',
      effects: [
        { kind: 'loseLife', player: 'opponent', amount: 2 },
        { kind: 'gainLife', player: 'you', amount: 2 },
      ],
    }],
  },

  // "{8}: Target player loses 3 life and you gain 3 life."
  'bloodrite-invoker': {
    activated: [{
      cost: { mana: { C: 8 } },
      effects: [
        { kind: 'loseLife', player: 'opponent', amount: 3 },
        { kind: 'gainLife', player: 'you', amount: 3 },
      ],
      sorcerySpeed: false,
      targets: [],
    }],
  },

  // --- Enters-the-battlefield --------------------------------------------------

  // "When this creature enters, each opponent discards a card."
  // Two-player game: "each opponent" is exactly the one opponent.
  'cackling-fiend': {
    triggers: [{
      on: 'onEnterBattlefield',
      effects: [{ kind: 'discard', player: 'opponent', count: 1 }],
    }],
  },

  // --- Attackers that stay home ---------------------------------------------------

  // "Flying. This creature can't block."
  // Flying comes from Scryfall's keyword list; only the restriction is authored.
  'vampire-interloper': {
    statics: [{ kind: 'cantBlock' }],
  },

  // --- Pump --------------------------------------------------------------------

  // "Flying. {1}{B}: This creature gets +1/+1 until end of turn."
  'nightwing-shade': {
    activated: [pumpAbility({ C: 1, B: 1 }, 1, 1)],
  },

  // --- Auras --------------------------------------------------------------------

  // "Enchant creature. Enchanted creature gets +2/+1 and has menace."
  'untamed-hunger': {
    statics: [{
      kind: 'aura',
      attachTo: ANY_CREATURE,
      power: 2,
      toughness: 1,
      keywords: ['menace'],
    }],
    targets: [ANY_CREATURE],
  },
};
