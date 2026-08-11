/**
 * Valor — mono-white soldiers.
 *
 * The one idea: a board full of small creatures is worth more than one big creature,
 * because a single pump effect hits all of them at once. Every card here is either a
 * body that arrives early, something that makes the whole team bigger, or the reward
 * for having survived to turn five.
 *
 * Serra Angel is the signature: the card a beginner is playing towards, and the only
 * thing in the deck that wins a game by itself.
 *
 * Deliberately absent: Wrath of God. A go-wide deck that sweeps its own board teaches
 * the exact opposite lesson.
 *
 * ## What the first version got wrong
 *
 * The original list won 67.7% of its games across the whole slate and had a winning
 * record in every single matchup — the clearest outlier on a six-deck ladder whose
 * spread was thirty-five points wide. The problem was never the anthems. It was that
 * the deck did not need them:
 *
 * 1. **Eight one-mana 2/1s.** Elite Vanguard and Savannah Lions are the same card
 *    twice over, and eight copies of it meant Valor won a large share of its games on
 *    raw curve with the anthem still in the library. A lesson the deck can skip is not
 *    a lesson. Savannah Lions is also the one body here that is not a Soldier, so
 *    Veteran Swordsmith never pumped it.
 * 2. **Sunlance.** One mana, three damage, and it answers the single card that beats a
 *    wide board — one large blocker — without costing a turn of development. The deck
 *    was solving its own weakness on the cheap. Valor's answer to a big creature is
 *    supposed to be "attack with six of them".
 * 3. **Above-rate everything else.** Four Raise the Alarm, four Kinsbaile Skirmisher
 *    (a 2/2 that pumps something for free on arrival), three Captain's Call and three
 *    Serra Angels. Individually reasonable; together, a deck with no bad draws.
 *
 * ## What replaced them
 *
 * Soldiers that are mediocre alone and good under an anthem — which is the sentence
 * the deck exists to teach:
 *
 * - **Gideon's Lawkeeper, three copies, in place of Savannah Lions.** A 1/1 for one
 *    that taps the blocker. It replaces Sunlance's job with a card that stays on the
 *    battlefield and grows with the team, it is a Soldier so the Swordsmith finally
 *    pumps the whole curve, and a 1/1 does not race the way a 2/1 does. Swapping the
 *    three of them in was worth three points on its own.
 * - **Master Decoy, two copies.** The same trick at two mana with an extra point of
 *    toughness, so the deck draws the effect often enough to plan around it.
 * - **Standing Troops, four copies.** A 1/4 vigilance reads as unplayable to a
 *    beginner. With one anthem out it is a 2/5 that attacks *and* blocks on the same
 *    turn; with two it is a 3/6. That is the deck's thesis printed on a single card.
 * - **Alaborn Trooper, two copies.** A 2/3 Soldier that survives the trade it makes.
 *
 * The anthems themselves are untouched in substance: nine anthem cards where there
 * were ten, still four Benalish Marshal and three Glorious Anthem. What changed is
 * everything under them.
 *
 * Measured over 240 seeds x both seat orders x Valor's five matchups (2400 games,
 * 'magician' tier): 67.4% -> 55.0% across the four matchups that do not involve Ember,
 * whose list was being rebuilt at the same time. Worst matchup 42% (Nightfall), best
 * 65% (Bloom). Valor is still a favourite against most of the field, which is what the
 * beginner's deck should be.
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
    // ---- Early plays: the "wide" half. Sixteen cards you can cast on turn one or
    // two, so a random seven almost always has a play. Raise the Alarm is the clearest
    // demonstration in the deck — one card, two creatures, and it is an instant.
    { oracleId: 'elite-vanguard', count: 4, isLand: false, cmc: 1, tags: ['soldier', 'early'] },
    { oracleId: 'raise-the-alarm', count: 3, isLand: false, cmc: 2, tags: ['soldier', 'tokens', 'wide'] },
    { oracleId: 'kinsbaile-skirmisher', count: 2, isLand: false, cmc: 2, tags: ['soldier', 'pump'] },
    { oracleId: 'youthful-knight', count: 2, isLand: false, cmc: 2, tags: ['early'] },

    // ---- The answer to one big blocker, which is the only thing that stops a wide
    // board. Tapping rather than killing: the answer is a Soldier, so it is still on
    // the table getting bigger when the anthem lands. This is what replaced Sunlance.
    { oracleId: 'gideon-s-lawkeeper', count: 3, isLand: false, cmc: 1, tags: ['soldier', 'early', 'tapper'] },
    { oracleId: 'master-decoy', count: 2, isLand: false, cmc: 2, tags: ['soldier', 'tapper'] },

    // ---- Payoff: the "one pump" half. Nine cards that turn the whole board into real
    // threats on the same turn. Two of the three are creatures, so drawing them early
    // is never a dead turn.
    { oracleId: 'benalish-marshal', count: 4, isLand: false, cmc: 3, tags: ['anthem', 'payoff'] },
    { oracleId: 'glorious-anthem', count: 3, isLand: false, cmc: 3, tags: ['anthem', 'payoff'] },
    { oracleId: 'veteran-swordsmith', count: 2, isLand: false, cmc: 3, tags: ['soldier', 'anthem', 'payoff'] },

    // ---- The bodies the anthems are for. Both are unimpressive on their own and
    // both are Soldiers, so every pump in the deck reaches them. Standing Troops in
    // particular only starts attacking once an anthem is out — see the header.
    { oracleId: 'standing-troops', count: 4, isLand: false, cmc: 3, tags: ['soldier', 'defense'] },
    { oracleId: 'alaborn-trooper', count: 2, isLand: false, cmc: 3, tags: ['soldier'] },

    // ---- Top end: Captain's Call is three bodies for one card — going wide, late.
    // Serra Angel is the deck's single bomb, and the only card above four mana.
    { oracleId: 'captain-s-call', count: 2, isLand: false, cmc: 4, tags: ['soldier', 'tokens', 'wide'] },
    { oracleId: 'serra-angel', count: 2, isLand: false, cmc: 5, tags: ['bomb', 'signature'] },

    // ---- Lands: 25, all basic. One color means no mana ever gets stuck in hand.
    // Twenty-five rather than twenty-four because the curve now leans on three: the
    // deck wants the third land on turn three every time.
    { oracleId: 'plains', count: 25, isLand: true, cmc: 0 },
  ],
};
