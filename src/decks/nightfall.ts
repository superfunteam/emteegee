/**
 * Nightfall — black/red.
 *
 * The one idea: **answering a threat is a play.** A beginner's instinct is that a turn
 * only counts if something of theirs hits the table. Nightfall spends ten of its
 * thirty-six spells doing nothing but killing the other player's creature, and it wins
 * anyway — because the creatures it does play take life while they take the board.
 *
 * The deck is built so that the two halves of the lesson show up in the same game:
 *
 *   1. Black answers. Doom Blade, Terror, Dark Banishing and Murder are deliberately
 *      near-identical, staggered 2/2/3/3, so the player meets the same decision four
 *      different times in one game and learns to hold the answer for the real threat.
 *   2. Life moves both ways. Child of Night, Bloodhunter Bat and Vampire Nighthawk all
 *      push the two life totals apart, so the player watches a game they are "not
 *      developing" in swing eight or ten points in their favour anyway.
 *
 * Vampire Nighthawk is the signature because it is the single best demonstration in the
 * pool of keywords stacking: flying means it usually gets through, deathtouch means
 * blocking it is a losing trade, and lifelink means every hit is a four-point swing.
 * Three words on one 2/3, and each one changes the answer to "should I block?".
 *
 * Red is deliberately the smaller half, and it is here for bodies, not for burn — Ember
 * owns burn, and this deck must not read as a second copy of it. There is no burn spell
 * in the sixty, only creatures. Bogardan Firefiend is the pick of them because it
 * keeps the lesson going after it dies.
 *
 * The top of the curve is one card, not a suite: Nightwing Shade. A 2/2 flier for five
 * is unremarkable until the turn there is nothing left to answer, at which point every
 * spare land turns into another point of damage in the air. It is the deck's finisher
 * and the reason a long, grindy, removal-heavy game still ends.
 */

import type { Deck } from './types';

export const NIGHTFALL: Deck = {
  id: 'nightfall',
  name: 'Nightfall',
  colors: ['B', 'R'],
  signature: 'vampire-nighthawk',
  theme: 'Destroy their creatures one at a time, and take their life for yourself.',
  teaches: 'Removal and life swing',
  // Piloting it is one recurring judgement call — is this the creature worth the answer?
  // That is a real decision, but it is the only one the deck asks per turn.
  complexity: 2,
  cards: [
    // ---- Early plays (16 spells at two mana or less) -----------------------------
    // Every one of these either trades up or moves a life total, so turns one and two
    // are never dead.
    { oracleId: 'typhoid-rats', count: 3, isLand: false, cmc: 1, tags: ['early', 'deathtouch'] },
    { oracleId: 'child-of-night', count: 4, isLand: false, cmc: 2, tags: ['early', 'lifelink', 'drain'] },
    { oracleId: 'viashino-pyromancer', count: 3, isLand: false, cmc: 2, tags: ['early', 'drain'] },

    // ---- Removal — the lesson ----------------------------------------------------
    // Four near-identical answers on purpose. Doom Blade and Terror at two mana, Dark
    // Banishing and Murder at three, so the choice repeats at every stage of the game.
    { oracleId: 'doom-blade', count: 4, isLand: false, cmc: 2, tags: ['removal'] },
    { oracleId: 'terror', count: 2, isLand: false, cmc: 2, tags: ['removal'] },
    { oracleId: 'dark-banishing', count: 2, isLand: false, cmc: 3, tags: ['removal'] },
    { oracleId: 'murder', count: 2, isLand: false, cmc: 3, tags: ['removal'] },

    // ---- Payoff — the vampires and the drain -------------------------------------
    // Flying, deathtouch and lifelink on one card, four times. The Bat is the same
    // lesson without combat: two life off them, two life onto you, no blocking involved.
    { oracleId: 'vampire-nighthawk', count: 4, isLand: false, cmc: 3, tags: ['signature', 'lifelink', 'drain'] },
    { oracleId: 'bloodhunter-bat', count: 3, isLand: false, cmc: 4, tags: ['drain'] },

    // ---- Red bodies — something to attack with while black answers ----------------
    // Bodies, not burn. Bogardan Firefiend is the best of them because it kills a second
    // creature on the way out, which is the removal lesson wearing a creature's face.
    { oracleId: 'bogardan-firefiend', count: 3, isLand: false, cmc: 3, tags: ['body'] },
    { oracleId: 'onakke-ogre', count: 2, isLand: false, cmc: 3, tags: ['body'] },
    { oracleId: 'hill-giant', count: 2, isLand: false, cmc: 4, tags: ['body'] },

    // ---- Top end — one bomb ------------------------------------------------------
    // The only card above four mana. Once the board is clear, every leftover land is
    // another point of evasive damage.
    { oracleId: 'nightwing-shade', count: 2, isLand: false, cmc: 5, tags: ['bomb'] },

    // ---- Lands (24) ---------------------------------------------------------------
    // Black is the demanding half — Vampire Nighthawk and Murder both want {B}{B} on
    // turn three — so Swamps lead. The ten red cards all cost a single {R} and none
    // arrive before turn two, which ten Mountains support comfortably.
    { oracleId: 'swamp', count: 14, isLand: true, cmc: 0 },
    { oracleId: 'mountain', count: 10, isLand: true, cmc: 0 },
  ],
};
