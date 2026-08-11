/**
 * Thicket — mono-green.
 *
 * The one idea: spend your early turns making mana, then cast something the other
 * player cannot deal with. Every card here is either a way to get to six mana faster
 * or a reason to want six mana.
 *
 * The curve is deliberately taller than the other five decks. That is the lesson, not
 * a mistake — but it only works because eight one-mana Elves turn a turn-three land
 * drop into five mana, and because Grizzly Bears and the Elves themselves give a
 * beginner something to do on turns one and two while the big things are still in hand.
 *
 * Craw Wurm is the signature: the first card a new player casts that simply cannot be
 * blocked profitably. Pelakka Wurm, a single copy, is the top of the deck's ambition.
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
    // ── Early plays: mana first, then a body ────────────────────────────────
    // Eight one-mana Elves. Drawing one is the difference between casting Craw
    // Wurm on turn five and casting it on turn seven.
    { oracleId: 'llanowar-elves', count: 4, isLand: false, cmc: 1, tags: ['ramp'] },
    { oracleId: 'elvish-mystic', count: 4, isLand: false, cmc: 1, tags: ['ramp'] },
    // Something to cast on turn two when the Elves do not show up.
    { oracleId: 'grizzly-bears', count: 3, isLand: false, cmc: 2, tags: ['early'] },
    { oracleId: 'garruk-s-companion', count: 2, isLand: false, cmc: 2, tags: ['early'] },

    // ── Combat tricks: turn a bad block into a good one ─────────────────────
    // The cheapest lesson in the game — blocking is not the end of the story.
    { oracleId: 'giant-growth', count: 3, isLand: false, cmc: 1, tags: ['pump'] },
    { oracleId: 'titanic-growth', count: 2, isLand: false, cmc: 2, tags: ['pump'] },

    // ── Midgame: what the ramp buys on turns three and four ─────────────────
    { oracleId: 'trained-armodon', count: 3, isLand: false, cmc: 3, tags: ['beater'] },
    { oracleId: 'rumbling-baloth', count: 3, isLand: false, cmc: 4, tags: ['beater'] },
    // Green's answer to a flyer. Skies exists; a beginner should not be helpless.
    { oracleId: 'giant-spider', count: 2, isLand: false, cmc: 4, tags: ['defense', 'reach'] },
    { oracleId: 'silverback-ape', count: 2, isLand: false, cmc: 5, tags: ['beater'] },

    // ── Top end: the payoff ────────────────────────────────────────────────
    { oracleId: 'craw-wurm', count: 3, isLand: false, cmc: 6, tags: ['fatty', 'signature'] },
    { oracleId: 'colossal-dreadmaw', count: 2, isLand: false, cmc: 6, tags: ['fatty', 'trample'] },
    // One bomb, not four. Seven power, seven life, and a card when it dies.
    { oracleId: 'pelakka-wurm', count: 1, isLand: false, cmc: 7, tags: ['bomb'] },

    // ── Finisher: all those bodies at once ─────────────────────────────────
    { oracleId: 'overrun', count: 2, isLand: false, cmc: 5, tags: ['finisher'] },

    // ── Lands ──────────────────────────────────────────────────────────────
    // 24, on the high side, because the deck genuinely wants to reach six mana.
    { oracleId: 'forest', count: 24, isLand: true, cmc: 0 },
  ],
};
