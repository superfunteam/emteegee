/**
 * Valor — mono-white soldiers.
 *
 * The one idea: a board full of small creatures is worth more than one big creature,
 * because a single pump effect hits all of them at once. Every card here is either a
 * body that arrives early, something that makes the whole team bigger, or the reward
 * for having survived to turn five.
 *
 * Deliberately absent: Wrath of God. A go-wide deck that sweeps its own board teaches
 * the exact opposite lesson.
 */

import type { Deck } from './types';

export const VALOR: Deck = {
  id: 'valor',
  name: 'Valor',
  colors: ['W'],
  signature: 'serra-angel',
  theme: 'Fill the board with small soldiers, then make every one of them bigger at the same time.',
  teaches: 'Going wide',
  complexity: 1,
  cards: [
    // ---- Early plays: the "wide" half. Twenty cards you can cast on turn one or two,
    // so a random seven almost always has a play. Raise the Alarm is the clearest
    // demonstration in the deck — one card, two creatures, and it is an instant.
    { oracleId: 'elite-vanguard', count: 4, isLand: false, cmc: 1, tags: ['soldier', 'early'] },
    { oracleId: 'savannah-lions', count: 4, isLand: false, cmc: 1, tags: ['early'] },
    { oracleId: 'raise-the-alarm', count: 4, isLand: false, cmc: 2, tags: ['soldier', 'tokens', 'wide'] },
    { oracleId: 'kinsbaile-skirmisher', count: 4, isLand: false, cmc: 2, tags: ['soldier', 'pump'] },
    { oracleId: 'youthful-knight', count: 2, isLand: false, cmc: 2, tags: ['early'] },

    // ---- Payoff: the "one pump" half. Ten cards that turn the whole board into real
    // threats on the same turn. Two of the three are creatures, so drawing them early
    // is never a dead turn.
    { oracleId: 'benalish-marshal', count: 4, isLand: false, cmc: 3, tags: ['anthem', 'payoff'] },
    { oracleId: 'glorious-anthem', count: 3, isLand: false, cmc: 3, tags: ['anthem', 'payoff'] },
    { oracleId: 'veteran-swordsmith', count: 3, isLand: false, cmc: 3, tags: ['soldier', 'anthem', 'payoff'] },

    // ---- Removal: the one answer, kept cheap so it never costs a development turn.
    { oracleId: 'sunlance', count: 2, isLand: false, cmc: 1, tags: ['removal'] },

    // ---- Top end: Captain's Call is three bodies for one card — going wide, late.
    // Serra Angel is the deck's single bomb, and the only card above four mana.
    { oracleId: 'captain-s-call', count: 3, isLand: false, cmc: 4, tags: ['soldier', 'tokens', 'wide'] },
    { oracleId: 'serra-angel', count: 3, isLand: false, cmc: 5, tags: ['bomb', 'signature'] },

    // ---- Lands: 24, all basic. One color means no mana ever gets stuck in hand.
    { oracleId: 'plains', count: 24, isLand: true, cmc: 0 },
  ],
};
