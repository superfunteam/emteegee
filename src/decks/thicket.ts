/**
 * Thicket — mono-green.
 *
 * The one idea: spend your early turns making mana, then cast something the other
 * player cannot deal with. Six one-mana Elves and twenty-five Forests pay for ten
 * creatures costing five or more, and Pelakka Wurm — seven power, seven life, and a
 * card when it dies — is what the ramp is actually for.
 *
 * Craw Wurm is the signature: the first card a new player casts that simply cannot be
 * blocked profitably.
 *
 * ## What the first version got wrong
 *
 * The original list won 31% of its games and had a losing record in all five
 * matchups, 17-83 against Nightfall. Three things were wrong with it, and the
 * playtest matrix — every pairing, hundreds of seeds — named all three:
 *
 * 1. **Five combat tricks.** Giant Growth and Titanic Growth are the right lesson and
 *    the wrong cards *here*. A pump spell is a card that does nothing unless it is
 *    held for the right combat, and a beginner — and the bot — spends it the turn it
 *    is castable. Six points of power that vanish at end of turn lost to a 2/3 that
 *    stays on the table. Cutting the five of them was worth about ten points of win
 *    rate on its own. Ember still teaches the trick, Nightfall still teaches the
 *    answer; this deck does not need to teach both.
 * 2. **Overrun.** Same problem, five mana worse, and it wants a wide board the deck
 *    never had. It measured at minus four to minus six every time it was tried.
 * 3. **Eight mana Elves.** Ramp is the lesson, but the eighth Elf is not ramp — it is
 *    a 1/1 in a deck that already has twenty-five lands. Six Elves still opens on a
 *    turn-one mana creature in half of all games and gives back two slots for cards
 *    that hold the ground. Going 8 -> 6 was worth five points.
 *
 * ## What replaced them
 *
 * Bodies that are still there next turn, and specifically bodies that answer the
 * things green cannot otherwise beat:
 *
 * - **Ambush Viper.** Green's honest removal spell. Deathtouch means any block kills
 *   anything — Serra Angel, a Hill Giant, a Shivan Dragon on the ground — and flash
 *   means it can come down after the attack is declared.
 * - **Giant Spider, three copies.** Nightfall's Vampire Nighthawk and the whole of
 *   Skies fly. Reach is green's only answer in this pool, and two copies was not
 *   enough to draw one.
 * - **Elvish Warrior.** A 2/3 for two blocks everything Ember and Valor play on turns
 *   one and two and survives, which is the whole of those matchups early on.
 *
 * The top end grew rather than shrank: a second Pelakka Wurm, and ten cards at five
 * mana or more. Ramping into a 6/4 that does nothing on arrival was never the
 * problem — ramping into it with a hand full of combat tricks was.
 *
 * Measured over 800 games per pairing: 47.5% overall, worst matchup 39%, best 61%.
 */

import type { Deck } from './types';

export const THICKET: Deck = {
  id: 'thicket',
  name: 'Thicket',
  colors: ['G'],
  signature: 'craw-wurm',
  theme: 'Start small, grow your mana, then drop a monster nobody can stop.',
  teaches: 'Ramp into giants',
  complexity: 1,
  cards: [
    // ── Mana first ──────────────────────────────────────────────────────────
    // Six one-mana Elves. Drawing one is the difference between casting Craw Wurm
    // on turn five and casting it on turn seven. Six rather than eight: past that
    // they stop being ramp and start being 1/1s. See the header.
    { oracleId: 'llanowar-elves', count: 4, isLand: false, cmc: 1, tags: ['ramp'] },
    { oracleId: 'elvish-mystic', count: 2, isLand: false, cmc: 1, tags: ['ramp'] },

    // ── Turns one and two: hold the ground while the big things are in hand ──
    // Deathtouch is green's removal spell. It does not read like one, which is the
    // lesson: the 2/1 that trades with Serra Angel is worth more than the 2/2 that
    // trades with nothing.
    { oracleId: 'ambush-viper', count: 4, isLand: false, cmc: 2, tags: ['removal', 'deathtouch'] },
    { oracleId: 'garruk-s-companion', count: 2, isLand: false, cmc: 2, tags: ['early', 'trample'] },
    // Three toughness for two mana: it blocks the entire first two turns of Ember,
    // Valor and Skies and is still there afterwards.
    { oracleId: 'elvish-warrior', count: 4, isLand: false, cmc: 2, tags: ['early'] },

    // ── Midgame: what the ramp buys on turns three and four ─────────────────
    { oracleId: 'trained-armodon', count: 3, isLand: false, cmc: 3, tags: ['beater'] },
    { oracleId: 'rumbling-baloth', count: 3, isLand: false, cmc: 4, tags: ['beater'] },
    // Green's only answer to a flier in this pool, and both Nightfall and Skies win
    // in the air. Three copies, so the deck actually draws one.
    { oracleId: 'giant-spider', count: 3, isLand: false, cmc: 4, tags: ['defense', 'reach'] },

    // ── Top end: what the Elves are for ─────────────────────────────────────
    { oracleId: 'silverback-ape', count: 3, isLand: false, cmc: 5, tags: ['fatty'] },
    { oracleId: 'craw-wurm', count: 3, isLand: false, cmc: 6, tags: ['fatty', 'signature'] },
    { oracleId: 'colossal-dreadmaw', count: 2, isLand: false, cmc: 6, tags: ['fatty', 'trample'] },
    // The payoff, and the only card in mono-green with real text on it: seven power,
    // seven life the turn it lands, and a card back when it finally dies. Two copies
    // is the most the curve will carry — at three it starts showing up in openers.
    { oracleId: 'pelakka-wurm', count: 2, isLand: false, cmc: 7, tags: ['bomb', 'trample'] },

    // ── Lands ───────────────────────────────────────────────────────────────
    // 25, high on purpose: ten of the thirty-five spells cost five or more.
    { oracleId: 'forest', count: 25, isLand: true, cmc: 0 },
  ],
};
