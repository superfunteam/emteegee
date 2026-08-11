/**
 * How the Magician scores a position.
 *
 * This is the one number every tier maximises. Apprentice, Magician and Archmage
 * differ only in how far they search and how much noise they add on top — the
 * table below and the arithmetic in {@link evaluate} are shared, per spec §7.
 * A tier that tuned its own weights would be a second bot, and the three would
 * stop being the same opponent at three difficulties.
 *
 * Three properties matter more than the exact numbers:
 *
 * 1. **Terminal states are ±Infinity.** Nothing finite can outweigh a win, so a
 *    lethal line is always chosen when the search reaches one, and a line that
 *    kills the bot is never chosen while any alternative exists.
 * 2. **Characteristics are read live.** Power, toughness and keywords come from
 *    `powerOf` / `toughnessOf` / `hasKeyword`, never off the `CardDef`. Reading
 *    the printed values would make the bot blind to its own Giant Growth, to the
 *    lord it just played, and to the `-1/-1` counters shrinking its blocker.
 * 3. **It never touches the state.** Scoring happens on positions produced by
 *    `reduce()` during search; a mutation here would corrupt the branch the
 *    caller is about to explore.
 *
 * The score is from `me`'s point of view and is *not* perfectly antisymmetric:
 * the board and life terms flip sign when you swap players, but cards in hand
 * and open mana are counted only for the player being scored. That is deliberate
 * — a card in the opponent's hand is unknown information, and pretending to
 * price it would be the bot peeking.
 */

import type { GameState, Keyword, PlayerId } from '../engine/types';
import { ALL_KEYWORDS } from '../engine/types';
import { hasKeyword, isCreature, opponentOf, powerOf, toughnessOf } from '../engine/state';

/**
 * What each keyword adds to a creature's score, on top of its power and
 * toughness. One table, shared by all three tiers.
 *
 * The shape of it is the bot's whole idea of what a creature is worth beyond
 * its stats: evasion and damage multipliers first, because they turn stats into
 * life totals — flying and double strike lead, menace, trample and deathtouch
 * follow. Defensive keywords score moderately: they make a creature harder to
 * remove or better at holding the ground, which is worth less than closing a
 * game. Reach, haste and flash are situational and priced accordingly.
 *
 * `defender` is negative. The bot's score is a race score — life totals and
 * board presence — and a creature that cannot attack contributes nothing to it
 * while still costing a card. Pricing it at zero would have the bot happily
 * trade a real threat for a wall.
 */
export const KEYWORD_VALUE: Record<Keyword, number> = {
  // Evasion and damage multipliers.
  'double strike': 2.5,
  flying: 2,
  deathtouch: 2,
  menace: 1.5,
  trample: 1.5,
  hexproof: 1.5,
  // Defensive and resilient.
  'first strike': 1,
  lifelink: 1,
  ward: 1,
  vigilance: 0.75,
  reach: 0.5,
  haste: 0.5,
  flash: 0.5,
  // A creature that cannot attack does not advance the race.
  defender: -2,
};

/** Life is worth this much per point of differential. */
const LIFE_WEIGHT = 2;
/** A card in hand is a threat or an answer not yet spent. */
const CARD_WEIGHT = 1.5;
/** Open mana is a fraction of a card: it only matters if there is something to spend it on. */
const LAND_WEIGHT = 0.5;

/**
 * Everything one player's creatures are worth: stats plus keywords.
 *
 * Only creatures count. A land or an enchantment on the battlefield has no power
 * or toughness to add, and its value shows up elsewhere — lands through
 * {@link untappedLands}, everything else through the board it is buffing, which
 * `powerOf` already folds in.
 */
function boardValue(state: GameState, player: PlayerId): number {
  let total = 0;
  for (const id of state.players[player].battlefield) {
    if (!state.cards[id]) continue;
    if (!isCreature(state, id)) continue;

    total += powerOf(state, id) + toughnessOf(state, id);
    for (const keyword of ALL_KEYWORDS) {
      if (hasKeyword(state, id, keyword)) total += KEYWORD_VALUE[keyword];
    }
  }
  return total;
}

/**
 * Untapped lands this player controls — mana available, roughly.
 *
 * Read off the definition rather than through a characteristic helper because
 * nothing in the effect vocabulary can turn a permanent into a land or back. A
 * token has no definition and is never a land, so the optional chain is the
 * whole of the token case.
 */
function untappedLands(state: GameState, player: PlayerId): number {
  let count = 0;
  for (const id of state.players[player].battlefield) {
    const card = state.cards[id];
    if (!card || card.tapped) continue;
    if (!state.defs[card.oracleId]?.cardTypes.includes('land')) continue;
    count += 1;
  }
  return count;
}

/**
 * Score a position from `me`'s point of view. Higher is better for `me`.
 *
 * ```
 * score =  (myLife - theirLife) * 2
 *        + sum(my creatures:    power + toughness + keyword values)
 *        - sum(their creatures: power + toughness + keyword values)
 *        + myHandSize     * 1.5
 *        + myUntappedLands * 0.5
 * ```
 *
 * Terminal states short-circuit to ±Infinity before any of that is computed. A
 * decided game is read off `state.winner`, which is the engine's own verdict and
 * covers losing by drawing from an empty library as well as by damage; the life
 * checks after it catch a position that has not had state-based actions applied
 * yet, which is what search does when it wants to know whether a line is lethal.
 *
 * Never mutates `state`.
 */
export function evaluate(state: GameState, me: PlayerId): number {
  const them = opponentOf(me);

  if (state.winner !== null) return state.winner === me ? Infinity : -Infinity;

  const myLife = state.players[me].life;
  const theirLife = state.players[them].life;
  if (theirLife <= 0) return Infinity;
  if (myLife <= 0) return -Infinity;

  return (
    (myLife - theirLife) * LIFE_WEIGHT +
    boardValue(state, me) -
    boardValue(state, them) +
    state.players[me].hand.length * CARD_WEIGHT +
    untappedLands(state, me) * LAND_WEIGHT
  );
}
