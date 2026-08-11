/**
 * Ember — mono-red goblins, then dragons.
 *
 * The one idea: attack from the first turn, and never stop having something bigger to
 * attack with. Sixteen Goblins come down on turns one to three — Goblin Chieftain is why
 * they add up, +1/+1 and haste to the rest of them — and behind them stand ten creatures
 * that a blocker cannot profitably eat. Shivan Dragon is the signature and the finish:
 * five power in the air, and every spare Mountain is another point of it.
 *
 * The cap from spec section 11 is deliberate and enforced by a test: six burn spells,
 * none larger than three damage. Ember is meant to be fast, not to end the game before
 * the other player has had a turn worth playing. This list uses four of the six.
 *
 * ## What the first version got wrong
 *
 * The original list won 36% of its games — 38% if you set aside Valor, which was an
 * outlier in its own right — and had a losing record in all five matchups. The playtest
 * matrix, replaying Ember's five pairings over 2400 games, named three causes.
 *
 * 1. **Eleven creatures with one toughness.** Goblin Piker, Goblin Roughrider and
 *    Viashino Pyromancer are all 2/1 or 3/2, and that is fatal *here* for a reason
 *    specific to this opponent: the Magician attacks with everything, always. One ply
 *    cannot see past the declare-blockers step, so attacking and not attacking score
 *    identically and the tie-break commits the board (`magician.ts`, "What one ply can
 *    and cannot see"). A deck of 2/1s therefore hands the other player a free creature
 *    every single turn. It showed in the losses: the old list finished its lost games
 *    with 0.8 creatures on the battlefield and one card in hand, against an opponent
 *    still on 13 life. It was not being raced — it was being eaten.
 * 2. **The sixth burn spell.** Every experiment that added burn measured worse, and
 *    every experiment that cut it measured better: dropping the two Shocks was worth two
 *    points, and going back up to six with a pair of Searing Spears cost three. The
 *    arithmetic is the evaluator's — three damage to the face scores +6, a dead blocker
 *    +2.5 — so the bot throws every burn spell at the face, which does nothing about the
 *    board that is killing it. The cap in spec section 11 was written as a fun
 *    constraint; it turns out to also be the correct one, and no version of this deck
 *    wants the two slots back.
 * 3. **Twenty-four lands was too few, not too many.** The obvious read on a deck with a
 *    2.2 curve is that it floods, so the first thing tried was cutting to 22. That lost
 *    three points. Twenty-five gained two. Firebreathing is why: Shivan Dragon and
 *    Furnace Whelp turn every spare Mountain into damage, so the land that would be dead
 *    in any other deck is a point of reach in this one.
 *
 * ## What replaced them
 *
 * Bodies a blocker cannot profitably eat, which is the same lesson Thicket learned from
 * the other side of the table:
 *
 * - **Onakke Ogre, four copies.** 4/2 for three: it kills whatever blocks it. Straight
 *   swapping it for Goblin Roughrider — one more power, one less Goblin — was the single
 *   largest gain in the rebuild, and it is what says the Chieftain synergy was never
 *   worth as much as the extra point of power.
 * - **Fire Elemental, three copies.** 5/4 for five. Nothing in this pool blocks it and
 *   lives, and at twenty-five lands it is reliably castable.
 * - **Shivan Dragon, two copies to four.** The old note said two was "enough to see it,
 *   not enough to clog". With the extra land and a curve that now wants to reach six, it
 *   is the best card in the deck and clogging is not what happens — cutting back to two
 *   cost three points.
 *
 * The Goblins that stayed are the ones that were never just a body: Raging Goblin is
 * haste in one card, Krenko's Command is two creatures from one, Ember Hauler is a body
 * that becomes two damage when the attack stops getting through, and Goblin Chieftain is
 * what makes the other three add up. Viashino Pyromancer stays at two for its two damage
 * on arrival; cutting it altogether measured worse than keeping it.
 *
 * Measured over 2400 games, fifteen-pairing harness restricted to Ember's five: 45%
 * overall, 47% setting Valor aside, worst matchup Nightfall at 35%, best Bloom at 57%.
 */

import type { Deck } from './types';

export const EMBER: Deck = {
  id: 'ember',
  name: 'Ember',
  colors: ['R'],
  signature: 'shivan-dragon',
  theme: 'Small, fast creatures that attack the moment they show up, then dragons.',
  teaches: 'Speed and reach',
  complexity: 1,
  cards: [
    // ── Turn one: something to do, every game ───────────────────────────────
    // Raging Goblin attacks the turn it lands. It is the lesson in one card.
    { oracleId: 'raging-goblin', count: 4, isLand: false, cmc: 1, tags: ['goblin', 'haste'] },
    // Reach: four spells, three damage each. The whole of the burn, and see the header
    // for why the deck does not want the other two slots the cap would allow.
    { oracleId: 'lightning-bolt', count: 4, isLand: false, cmc: 1, tags: ['burn'], burnDamage: 3 },

    // ── Turn two: Goblins that are more than a body ──────────────────────────
    // Two creatures from one card, and Chieftain pumps both.
    { oracleId: 'krenko-s-command', count: 4, isLand: false, cmc: 2, tags: ['goblin', 'tokens'] },
    // A body first, damage later: sacrifice it for 2 once the attack stops getting through.
    { oracleId: 'ember-hauler', count: 4, isLand: false, cmc: 2, tags: ['goblin', 'reach'] },
    // Not a Goblin, and a 2/1 — kept at two anyway, for the two damage on arrival.
    { oracleId: 'viashino-pyromancer', count: 2, isLand: false, cmc: 2, tags: ['reach'] },

    // ── Turn three: the payoff, and the first body that fights back ──────────
    // +1/+1 and haste to every other Goblin. Play it and the whole board attacks.
    { oracleId: 'goblin-chieftain', count: 4, isLand: false, cmc: 3, tags: ['goblin', 'lord', 'haste'] },
    // 4/2. Two toughness still dies, but four power kills whatever killed it — which is
    // the difference between trading and being eaten. See the header.
    { oracleId: 'onakke-ogre', count: 4, isLand: false, cmc: 3, tags: ['beater'] },

    // ── The top end: what twenty-five Mountains are actually for ─────────────
    // The same "{R}: +1/+0" as Shivan at two-thirds the price, so the trick is familiar
    // by the time the real dragon arrives.
    { oracleId: 'furnace-whelp', count: 2, isLand: false, cmc: 4, tags: ['flier'] },
    // 5/4: nothing in this pool blocks it and lives.
    { oracleId: 'fire-elemental', count: 3, isLand: false, cmc: 5, tags: ['beater'] },
    // The signature and the finish. Five power in the air, and every leftover Mountain
    // is another point of it.
    { oracleId: 'shivan-dragon', count: 4, isLand: false, cmc: 6, tags: ['bomb', 'flier', 'signature'] },

    // ── Lands ────────────────────────────────────────────────────────────────
    // 25, one more than the first list ran. High for a curve this low, and deliberately:
    // firebreathing means the spare mana is damage, so the land is never a dead draw.
    { oracleId: 'mountain', count: 25, isLand: true, cmc: 0 },
  ],
};
