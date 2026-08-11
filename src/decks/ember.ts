/**
 * Ember — mono-red goblins and burn.
 *
 * The idea: small creatures that attack the turn they arrive, and a handful of spells
 * that finish the job when the board stalls. Goblin Chieftain is why the goblins add up
 * (+1/+1 and haste to the rest of them), and Shivan Dragon is the one card that ends a
 * long game on its own.
 *
 * The cap from spec section 11 is deliberate and enforced by a test: six burn spells,
 * none larger than three damage. Ember is meant to be fast, not to end the game before
 * the other player has had a turn worth playing. Everything past that six is a body on
 * the board — a creature the opponent can block, kill, or race.
 */

import type { Deck } from './types';

export const EMBER: Deck = {
  id: 'ember',
  name: 'Ember',
  colors: ['R'],
  signature: 'shivan-dragon',
  theme: 'Small, fast creatures that attack the moment they show up, plus a few spells that finish it.',
  teaches: 'Speed and reach',
  complexity: 1,
  cards: [
    // --- Early plays: something to do on turn one, every game ---------------
    // Raging Goblin attacks the turn it lands. It is the whole deck in one card.
    { oracleId: 'raging-goblin', count: 4, isLand: false, cmc: 1, tags: ['goblin', 'haste'] },
    { oracleId: 'goblin-piker', count: 4, isLand: false, cmc: 2, tags: ['goblin'] },
    // Two goblins from one card — the widest a two-drop gets, and Chieftain pumps both.
    { oracleId: 'krenko-s-command', count: 4, isLand: false, cmc: 2, tags: ['goblin', 'tokens'] },
    // A body first, damage later: sacrifice it for 2 when the attack stops getting through.
    { oracleId: 'ember-hauler', count: 4, isLand: false, cmc: 2, tags: ['goblin', 'reach'] },
    // Not a goblin, but it teaches the lesson on arrival: 2 damage straight to the face.
    { oracleId: 'viashino-pyromancer', count: 3, isLand: false, cmc: 2, tags: ['reach'] },

    // --- Payoff: the card that makes the small creatures add up -------------
    // +1/+1 and haste to every other goblin. Play it and the whole board attacks.
    { oracleId: 'goblin-chieftain', count: 4, isLand: false, cmc: 3, tags: ['goblin', 'lord', 'haste'] },
    { oracleId: 'goblin-roughrider', count: 3, isLand: false, cmc: 3, tags: ['goblin'] },

    // --- Reach: six spells, three damage each at most. This cap is a test. ---
    { oracleId: 'lightning-bolt', count: 4, isLand: false, cmc: 1, tags: ['burn'], burnDamage: 3 },
    { oracleId: 'shock', count: 2, isLand: false, cmc: 1, tags: ['burn'], burnDamage: 2 },

    // --- Top end: a small dragon that rehearses the big one ------------------
    // Same "{R}: +1/+0" as Shivan, at half the price, so the trick is familiar by the
    // time the real dragon shows up.
    { oracleId: 'furnace-whelp', count: 2, isLand: false, cmc: 4, tags: ['flier'] },
    // The bomb. One kind of bomb, two copies — enough to see it, not enough to clog.
    { oracleId: 'shivan-dragon', count: 2, isLand: false, cmc: 6, tags: ['bomb', 'flier'] },

    // --- Lands ---------------------------------------------------------------
    // 24: high enough to hit six for the dragon, and the leftovers are never dead —
    // Shivan and the Whelp turn spare mana into damage.
    { oracleId: 'mountain', count: 24, isLand: true, cmc: 0 },
  ],
};
