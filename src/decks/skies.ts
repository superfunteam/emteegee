/**
 * Skies — blue/white fliers.
 *
 * One idea: a creature on the ground cannot block a creature in the air. The deck is
 * built so the player discovers that themselves, usually around turn four, when their
 * opponent has a bigger board and is still losing. Twenty-eight of the thirty-one
 * creatures fly. The three that do not are Man-o'-War, which is here to move a blocker
 * out of the way rather than to fight.
 *
 * The whole list serves that one lesson:
 *   - the cheap fliers make the point early, while it is still cheap to learn;
 *   - Unsummon and Man-o'-War teach that a problem can be answered by moving it, not
 *     only by killing it;
 *   - Sunlance answers the only thing that ever blocks you — their fliers;
 *   - Air Elemental and Serra Angel end it.
 *
 * Deliberately absent: Counterspell, Essence Scatter and Negate are all legal here and
 * all excluded. See spec section 11 — a beginner's first blue card should not teach
 * "your turn did nothing".
 *
 * Mana base, by pips across the 36 spells: 29 blue, 21 white. That is 58/42, but the
 * lands are split 13/11 (54/46) because the two colors want their sources at different
 * times. White's double cost is Leonin Skyhunter on turn two, and a turn-two cost has
 * to be paid on turn two. Blue's double costs are Mist Raven and Air Elemental at four
 * and five, by which point almost any opening has found a second Island. Weight the
 * base toward the pip that comes due first.
 */

import type { Deck } from './types';

export const SKIES: Deck = {
  id: 'skies',
  name: 'Skies',
  colors: ['U', 'W'],
  signature: 'air-elemental',
  theme: 'Your creatures have wings. Theirs do not, and a creature stuck on the ground cannot stop one in the air.',
  teaches: 'Attack from above',
  complexity: 2,
  cards: [
    // ---- Early plays: put something in the air on turn one ------------------
    // Sixteen cards at two mana or less, so a random seven always has a turn.
    { oracleId: 'healer-s-hawk', count: 4, isLand: false, cmc: 1, tags: ['flier', 'early'] },
    { oracleId: 'leonin-skyhunter', count: 4, isLand: false, cmc: 2, tags: ['flier', 'early'] },
    { oracleId: 'zephyr-falcon', count: 3, isLand: false, cmc: 2, tags: ['flier', 'early'] },

    // ---- Tempo: move the blocker instead of killing it ----------------------
    // Unsummon and Man-o'-War are the deck's second thought. Bouncing their only
    // flier for one mana wins the turn the attack was going to lose.
    { oracleId: 'unsummon', count: 3, isLand: false, cmc: 1, tags: ['tempo', 'bounce'] },
    { oracleId: 'man-o-war', count: 3, isLand: false, cmc: 3, tags: ['tempo', 'bounce'] },

    // ---- Removal: the only creatures that can block you are theirs that fly --
    { oracleId: 'sunlance', count: 2, isLand: false, cmc: 1, tags: ['removal'] },

    // ---- Payoff: the curve of fliers that actually wins the game ------------
    { oracleId: 'wind-drake', count: 4, isLand: false, cmc: 3, tags: ['flier'] },
    { oracleId: 'sky-spirit', count: 3, isLand: false, cmc: 3, tags: ['flier'] },
    { oracleId: 'phantom-monster', count: 3, isLand: false, cmc: 4, tags: ['flier'] },
    { oracleId: 'mist-raven', count: 2, isLand: false, cmc: 4, tags: ['flier', 'bounce'] },

    // ---- Top end: one bomb, not four ---------------------------------------
    // Air Elemental is the deck's face. Serra Angel is the second copy of the
    // feeling — attacks for four in the air and is still home to block.
    { oracleId: 'air-elemental', count: 3, isLand: false, cmc: 5, tags: ['flier', 'bomb'] },
    { oracleId: 'serra-angel', count: 2, isLand: false, cmc: 5, tags: ['flier', 'bomb'] },

    // ---- Lands: 24 -----------------------------------------------------------
    { oracleId: 'island', count: 13, isLand: true, cmc: 0 },
    { oracleId: 'plains', count: 11, isLand: true, cmc: 0 },
  ],
};
