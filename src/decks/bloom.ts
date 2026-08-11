/**
 * Bloom — green/white, "+1/+1 counters compound".
 *
 * One idea: **a counter never goes away.** Ajani's Pridemate is a 2/2 that grows a
 * permanent +1/+1 every time you gain life, and the deck's whole job is to gain life
 * over and over on a schedule a beginner can see coming. By turn five or six the
 * Pridemate is a 6/6 that nobody agreed to, and the player understands why: they
 * watched it happen one point at a time.
 *
 * ## What actually feeds the Pridemate, and why the obvious build does not work
 *
 * The engine enforces spec §5 — *a trigger may not enqueue a trigger*. `resolveTop`
 * sets `resolvingTrigger` for the duration of a triggered ability, and `fireTriggers`
 * declines to enqueue anything while it is set. So life gained **by a triggered
 * ability** never reaches `onLifeGain`, and the Pridemate does not grow.
 *
 * That rules out the intuitive lifegain package, and it was verified against the
 * engine rather than assumed:
 *
 * | Life source                     | Kind             | Pridemate grows? |
 * |---------------------------------|------------------|------------------|
 * | Healer's Hawk (lifelink damage) | combat damage    | **yes**          |
 * | Sacred Nectar (sorcery)         | spell resolution | **yes**          |
 * | Soul Warden                     | triggered ability| no               |
 * | Angel of Mercy ETB              | triggered ability| no               |
 * | Pelakka Wurm ETB                | triggered ability| no               |
 *
 * So Soul Warden is **not in this deck**. Four copies of a card that gains life and
 * visibly fails to grow the cat is the single most confusing thing this deck could
 * ship: it teaches a beginner that the rule they just learned is unreliable. The
 * lifegain here is exactly the lifegain that works — lifelink in combat, and one
 * sorcery — so the trigger fires every single time the player expects it to.
 *
 * Angel of Mercy and Pelakka Wurm stay, but they earn their slots as a flier and as
 * the bomb. Their life is a cushion, not part of the lesson.
 *
 * ## Shape
 *
 * Twenty nonland cards cost two or less, so there is always a turn-one or turn-two
 * play. Fourteen creatures with reach, four toughness, or both hold the ground while
 * the counters pile up — the deck wins by *outliving* the opening, not by racing it.
 * One bomb at the top, and only one.
 */

import type { Deck } from './types';

export const BLOOM: Deck = {
  id: 'bloom',
  name: 'Bloom',
  colors: ['G', 'W'],
  signature: 'ajani-s-pridemate',
  theme: 'Every time you gain life, your cat gets permanently bigger — and it never shrinks back.',
  teaches: '+1/+1 counters compound',
  // Piloting is: play a creature, swing with the hawk, watch the number climb. The one
  // real decision is which creature to tap with Gideon's Lawkeeper.
  complexity: 2,

  cards: [
    // ---------------------------------------------------------------------
    // The payoff. Everything else in the deck is here to make this card big.
    // ---------------------------------------------------------------------
    { oracleId: 'ajani-s-pridemate', count: 4, isLand: false, cmc: 2, tags: ['payoff', 'counters'] },

    // ---------------------------------------------------------------------
    // Early plays — the life gain that actually puts counters on it.
    // Healer's Hawk is the engine: a 1/1 flier is hard to block, so it connects
    // most turns, and every connection is one more counter, forever.
    // ---------------------------------------------------------------------
    { oracleId: 'healer-s-hawk', count: 4, isLand: false, cmc: 1, tags: ['lifegain', 'lifelink', 'flying'] },
    { oracleId: 'sacred-nectar', count: 3, isLand: false, cmc: 2, tags: ['lifegain'] },

    // ---------------------------------------------------------------------
    // Early plays — bodies that survive the opening so the cat has time to grow.
    // Canopy Spider blocks fliers, Wall of Omens replaces itself and walls off
    // the ground, and Gideon's Lawkeeper is the closest thing green/white has to
    // removal: it taps the blocker standing in front of a 6/6.
    // ---------------------------------------------------------------------
    { oracleId: 'canopy-spider', count: 4, isLand: false, cmc: 2, tags: ['defense', 'reach'] },
    { oracleId: 'wall-of-omens', count: 3, isLand: false, cmc: 2, tags: ['defense', 'draw'] },
    { oracleId: 'gideon-s-lawkeeper', count: 2, isLand: false, cmc: 1, tags: ['tapper'] },

    // ---------------------------------------------------------------------
    // Midgame — plain, honest bodies. Their job is to make attacking into you a
    // bad idea for two or three turns.
    // ---------------------------------------------------------------------
    { oracleId: 'alaborn-trooper', count: 3, isLand: false, cmc: 3, tags: ['body'] },
    { oracleId: 'trained-armodon', count: 3, isLand: false, cmc: 3, tags: ['body'] },
    { oracleId: 'giant-spider', count: 3, isLand: false, cmc: 4, tags: ['defense', 'reach'] },
    { oracleId: 'rumbling-baloth', count: 2, isLand: false, cmc: 4, tags: ['body'] },

    // ---------------------------------------------------------------------
    // Top end — a flier that also buys three life, and one bomb.
    // ---------------------------------------------------------------------
    { oracleId: 'angel-of-mercy', count: 3, isLand: false, cmc: 5, tags: ['flying'] },
    { oracleId: 'pelakka-wurm', count: 2, isLand: false, cmc: 7, tags: ['bomb', 'trample'] },

    // ---------------------------------------------------------------------
    // Lands — 24, split down the middle.
    // 22 white pips against 23 green, so the base is even. White's pips all sit at
    // one and two mana and green's start at two, but green asks for {G}{G} at three
    // and {G}{G}{G} on the Wurm, and those two pulls cancel out at 12/12.
    // ---------------------------------------------------------------------
    { oracleId: 'plains', count: 12, isLand: true, cmc: 0 },
    { oracleId: 'forest', count: 12, isLand: true, cmc: 0 },
  ],
};
