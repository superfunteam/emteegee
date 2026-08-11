/**
 * The Magician: the opponent, at three difficulties.
 *
 * The whole design rests on one structural property: **the bot cannot cheat.**
 * It never constructs an `Action`. Every move it considers, and every move it
 * plays, came out of `legalActions(state)`, and every position it looks at was
 * produced by `reduce()` — the same reducer the human's taps go through. So a
 * bot that attacked with a tapped creature, cast a spell it could not pay for,
 * or blocked a flier with a ground creature would not be a bot with a bug; it
 * would be an engine with a bug, and the engine's own tests would catch it. That
 * is a stronger guarantee than any amount of care in this file could give.
 *
 * Four properties hold throughout:
 *
 * 1. **Pure.** No DOM, no `Math.random`, no timers. The only clock is
 *    `performance.now()`, read solely to answer "is the Archmage out of budget?"
 *    — it can shorten a search, never change what a completed search returns.
 *    The Apprentice's randomness is a seeded {@link makeRng} stream derived from
 *    `state.rngSeed` and `state.turn`, so the same position plays the same way.
 * 2. **Nothing is mutated.** `reduce()` hands back a new state and the search
 *    walks those; the state a caller passes in is only ever read.
 * 3. **One evaluator.** All three tiers maximise `evaluate()` from `evaluate.ts`
 *    and share the scoring rules in this file. They differ *only* in search: how
 *    many plies, and how much noise on top. A tier with its own weights would be
 *    a second bot wearing the same name.
 * 4. **It always answers.** Every path returns an `Action`. A throw anywhere in
 *    the search is caught and answered with a legal fallback, because a bot that
 *    dies mid-turn takes the whole game with it (spec §7: the UI must never
 *    stall).
 *
 * ## Scoring a candidate
 *
 * A candidate is scored by `reduce()`-ing it and evaluating the position that
 * comes out — with one necessary continuation, {@link settle}: while something
 * is still on the stack, the line is carried forward by `pass` actions until it
 * resolves. Without that, casting a spell is *always* a loss on the board — a
 * card leaves your hand and lands tap, and the spell has not done anything yet —
 * and the bot would never cast anything. Settling models an opponent who does
 * not respond, which is the honest assumption at one ply; the Archmage's second
 * ply models the reply for real.
 *
 * ## What one ply can and cannot see
 *
 * `reduce()` on a `declareAttackers` action stops at the declare-blockers step
 * whenever the defender has a block to make. So a one-ply search sees the *full*
 * consequence of an attack only when nothing can block — which is exactly the
 * case that matters most, because that is where lethal lives. Into an open
 * board, the one-ply tiers are genuinely blind: attacking and not attacking
 * score identically, and {@link commitment} breaks that tie toward attacking. A
 * bot that never attacks into a possible blocker never wins a game, and at one
 * ply there is no information to prefer anything else. Seeing past the block is
 * what the Archmage's second ply is *for*, and is the real difference between
 * the tiers.
 *
 * Blocking is the other way round: the bot's own `declareBlockers` action runs
 * through the damage step in one `reduce()`, so every tier sees exactly what a
 * block trades for what. Trading correctly is decided on defense, and on defense
 * one ply is enough.
 */

import type { Action, GameState, PlayerId } from '../engine/types';
import { legalActions } from '../engine/actions';
import { reduce } from '../engine/rules';
import { makeRng } from '../engine/rng';
import { evaluate } from './evaluate';

export type Tier = 'apprentice' | 'magician' | 'archmage';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How many combat declarations the bot will score for the move it is actually
 * about to play.
 *
 * A combat declaration is set-valued, so the space of them is exponential in the
 * board size: every subset of the attackers, every assignment of blockers. The
 * engine already declines to enumerate that — `legalActions` offers a curated
 * candidate list for combat and `validateAttack` / `validateBlocks` are the
 * definition of legal — but the list still grows with the board, roughly one
 * entry per blocker-attacker pair. This is the bot's own ceiling on top of that,
 * so a search cost can never become a wide board's problem.
 *
 * Set high enough that on any board this game can reach it keeps essentially
 * every block the engine offers, because which creature blocks which attacker is
 * the most consequential decision the bot makes.
 */
export const MAX_COMBAT_CANDIDATES = 32;

/**
 * How many combat declarations the bot will score for a *modelled* move — the
 * opponent's reply inside the Archmage's search, and anything deeper.
 *
 * Deliberately much smaller than {@link MAX_COMBAT_CANDIDATES}. Interior width
 * multiplies: every extra reply is scored once per candidate at the root, and
 * the Archmage has 120ms for all of it. Guessing the opponent's answer slightly
 * coarsely and finishing the search beats modelling it exactly and running out
 * of clock, which is the same reason every engine searches wider at the root
 * than in the tree.
 */
export const MAX_REPLY_CANDIDATES = 12;

/** How many of the sampled slots may go to single-creature declarations. */
const SINGLE_DECLARATION_SLOTS = 6;

/** Two passes resolve one stack object, and the stack holds at most three. */
const SETTLE_LIMIT = 12;

/** Spec §7: the Archmage thinks for at most this long, then plays. */
export const ARCHMAGE_BUDGET_MS = 120;

/** Two ply: my move, and your best reply. */
export const ARCHMAGE_MAX_DEPTH = 2;

/**
 * The Apprentice's softmax temperature, in score points.
 *
 * High, per spec §7. Two lines a few points apart are close to a coin flip,
 * which is what makes the Apprentice play *reasonably* rather than *well*: it
 * develops its board and does not walk into its own death, but it takes the
 * second-best trade often enough to be beaten by someone who has never played
 * before.
 */
export const APPRENTICE_TEMPERATURE = 6;

/**
 * How far above the best finite line a winning line sits, for the Apprentice.
 *
 * `evaluate` reports a decided game as ±Infinity, and a softmax over an infinite
 * score is a delta function: the Apprentice would take every lethal attack on
 * the board, every time, which is precisely what this tier is supposed to *not*
 * do. So a win is priced as a strong but resistible pull — a couple of
 * temperatures above the best real move, which finds lethal most of the time and
 * misses it often enough to be a tier.
 *
 * The margin is measured against the candidates in *this* position rather than
 * fixed on an absolute scale, because the score of a position is unbounded: at
 * twenty life against an empty board every move already scores far above any
 * constant, and a fixed ceiling would flatten "good" and "lethal" into the same
 * number.
 */
export const APPRENTICE_WIN_EDGE = 18;

/**
 * How far *below* the worst finite line a losing line sits.
 *
 * Deliberately several times {@link APPRENTICE_WIN_EDGE}: an Apprentice that
 * misses lethal is a beatable opponent, but one that walks into its own death is
 * a broken one. At this distance the move is drawn with probability around one
 * in three thousand.
 */
export const APPRENTICE_LOSS_EDGE = 48;

/**
 * Thrown when the Archmage's clock runs out mid-search. Not an error: the root
 * catches it and plays the best move the last completed depth found.
 */
const BUDGET_EXPIRED = Symbol('archmage budget expired');

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * Apply an action, or report that it could not be applied.
 *
 * `reduce()` throws on an illegal action and the bot only ever hands it actions
 * `legalActions` produced, so this should never catch anything. It exists so
 * that if the engine ever does throw — a data bug in one card, a trigger that
 * cannot resolve — the bot loses that one candidate rather than its whole turn.
 */
function safeReduce(state: GameState, action: Action): GameState | null {
  try {
    return reduce(state, action).state;
  } catch {
    return null;
  }
}

/**
 * Carry a line forward until nothing is waiting on the stack.
 *
 * A spell that has been cast has not done anything yet: it sits on the stack,
 * its cost already paid. Evaluating there prices a Lightning Bolt as "a card
 * gone and a land tapped", so a bot that scored positions without settling would
 * cast nothing, ever. Passing until the stack empties is what lets the score of
 * "cast this" be the score of what casting it *does*.
 *
 * The passes come from `legalActions`, like everything else, and are applied to
 * whichever player holds priority — so this models both players declining to
 * respond. That is the standard null-move assumption, and it is the assumption a
 * one-ply search is entitled to; the Archmage's second ply replaces it with a
 * real reply.
 *
 * Bounded at {@link SETTLE_LIMIT}: two passes resolve one object, the stack caps
 * at three, and phase changes are never reached because the loop stops the
 * moment the stack is empty.
 */
function settle(state: GameState): GameState {
  let next = state;
  for (let step = 0; step < SETTLE_LIMIT; step++) {
    if (next.winner !== null) return next;
    if (next.stack.length === 0) return next;

    const passing = legalActions(next).find((action) => action.kind === 'pass');
    if (!passing) return next;

    const after = safeReduce(next, passing);
    if (after === null) return next;
    next = after;
  }
  return next;
}

/** What a settled position is worth to `me`. The one number every tier maximises. */
function scoreOf(state: GameState, me: PlayerId): number {
  return evaluate(settle(state), me);
}

/** Apply an action and score the position it leads to, or `null` if it could not be applied. */
function scoreAction(state: GameState, action: Action, me: PlayerId): number | null {
  const next = safeReduce(state, action);
  return next === null ? null : scoreOf(next, me);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** How many creatures a combat declaration commits. Everything else commits nothing. */
function sizeOf(action: Action): number {
  if (action.kind === 'declareAttackers') return action.attackers.length;
  if (action.kind === 'declareBlockers') return action.blocks.length;
  return 0;
}

/**
 * Sample a list of combat declarations down to `limit`.
 *
 * Four things go in, in this order, and the order is the whole design:
 *
 * 1. **The empty declaration** — declining to attack, or declining to block. It
 *    is always a legal, often correct choice and must never be sampled away.
 * 2. **The fullest declaration** — the all-in attack, the greediest block.
 *    Lethal, when lethal exists on the board, is the all-in attack; keeping it
 *    unconditionally is what makes "the cap never costs a lethal attack" true
 *    rather than likely.
 * 3. **Single-creature declarations**, up to {@link SINGLE_DECLARATION_SLOTS} —
 *    attacking with just the flier, chump-blocking with just the wall.
 * 4. **A stride across the rest** for the remaining slots. Taking a prefix would
 *    bias the sample toward whichever creature the generator happened to walk
 *    first, which is the oldest permanent on the battlefield. A stride spans the
 *    whole list instead.
 *
 * Nothing here builds an action: every element returned is one the generator
 * offered, picked out by predicate.
 */
function sampleDeclarations(list: readonly Action[], limit: number): Action[] {
  if (list.length <= limit) return [...list];

  const picked: Action[] = [];
  const take = (action: Action | undefined): void => {
    if (!action) return;
    if (picked.length >= limit) return;
    if (picked.includes(action)) return;
    picked.push(action);
  };

  take(list.find((action) => sizeOf(action) === 0));

  let fullest = list[0]!;
  for (const action of list) {
    if (sizeOf(action) > sizeOf(fullest)) fullest = action;
  }
  take(fullest);

  const singlesUntil = picked.length + SINGLE_DECLARATION_SLOTS;
  for (const action of list) {
    if (picked.length >= singlesUntil) break;
    if (sizeOf(action) === 1) take(action);
  }

  const stride = Math.max(1, Math.floor(list.length / limit));
  for (let i = 0; i < list.length && picked.length < limit; i += stride) {
    take(list[i]);
  }
  return picked;
}

/**
 * The moves a search will actually score, in the generator's own order.
 *
 * Everything that is not a combat declaration is kept: a removal spell dropped
 * by a cap is a removal spell the bot never casts, and those lists are bounded
 * by the board rather than by the subsets of it. Attacks and blocks are sampled
 * by {@link sampleDeclarations}, each against the limit on its own so a wide
 * attack cannot crowd out the blocks.
 */
function pickCandidates(options: readonly Action[], limit: number): Action[] {
  const attacks = options.filter((action) => action.kind === 'declareAttackers');
  const blocks = options.filter((action) => action.kind === 'declareBlockers');
  if (attacks.length <= limit && blocks.length <= limit) return [...options];

  const kept = new Set<Action>([
    ...sampleDeclarations(attacks, limit),
    ...sampleDeclarations(blocks, limit),
  ]);
  return options.filter(
    (action) =>
      (action.kind !== 'declareAttackers' && action.kind !== 'declareBlockers') || kept.has(action),
  );
}

// ---------------------------------------------------------------------------
// Choosing between equals
// ---------------------------------------------------------------------------

/**
 * How much of the board an action commits to combat. The tie-break, and only the
 * tie-break.
 *
 * A one-ply search cannot see past the declare-blockers step, so an attack into
 * an open board and no attack at all score *exactly* the same — same life, same
 * creatures, same hand. Something has to break that tie, and "attack" is the
 * only answer that ever wins a game. It is deliberately not part of `evaluate`:
 * it decides nothing when the evaluator has an opinion.
 */
function commitment(action: Action): number {
  return action.kind === 'declareAttackers' ? action.attackers.length : 0;
}

/** Strictly better: a higher score, or the same score with more creatures committed. */
function isBetter(score: number, action: Action, bestScore: number, best: Action | null): boolean {
  if (best === null) return true;
  if (score > bestScore) return true;
  if (score < bestScore) return false;
  return commitment(action) > commitment(best);
}

/** The last-resort answer: pass if the generator offered one, otherwise anything legal. */
function fallback(options: readonly Action[]): Action {
  return options.find((action) => action.kind === 'pass') ?? options[0] ?? { kind: 'pass' };
}

// ---------------------------------------------------------------------------
// The land drop
// ---------------------------------------------------------------------------

/**
 * Take the land drop before searching anything.
 *
 * This is the one decision the bot does not search, and the reason is
 * arithmetic. `evaluate` prices a card in hand at 1.5 and an untapped land at
 * 0.5 (spec §7), so playing a land is worth **−1.0** the instant it happens: a
 * card left your hand and half a card arrived on the table. Every greedy search
 * therefore refuses the land drop — and a bot that never plays a land never
 * casts a spell, never attacks, and loses every game by decking out. Nor does
 * depth fix it: a land played on turn two pays for itself on turn three, and no
 * two-ply search reaches next turn.
 *
 * So the land drop is treated as what it is at this power level: not a decision.
 * The bot takes it, as every human does, and searches the moves that are
 * actually moves. The choice is still made through `legalActions` and `reduce` —
 * *which* land is decided by looking one action further and asking which one
 * leaves the best position, so a Forest is played over a Swamp when the Forest
 * is what casts the creature in hand.
 */
function landDrop(state: GameState, me: PlayerId, options: readonly Action[]): Action | null {
  const lands = options.filter((action) => action.kind === 'playLand');
  if (lands.length === 0) return null;
  if (lands.length === 1) return lands[0]!;

  // Two copies of the same land are the same decision; score one of each kind.
  const seen = new Set<string>();
  let best: Action | null = null;
  let bestScore = -Infinity;

  for (const land of lands) {
    if (land.kind !== 'playLand') continue;
    const oracleId = state.cards[land.card]?.oracleId;
    if (oracleId !== undefined) {
      if (seen.has(oracleId)) continue;
      seen.add(oracleId);
    }

    const next = safeReduce(state, land);
    if (next === null) continue;

    const score = bestFollowUp(next, me);
    if (best === null || score > bestScore) {
      best = land;
      bestScore = score;
    }
  }
  return best ?? lands[0]!;
}

/** The best this position gets from one more action, or from standing still. */
function bestFollowUp(state: GameState, me: PlayerId): number {
  let best = scoreOf(state, me);
  for (const action of pickCandidates(legalActions(state), MAX_REPLY_CANDIDATES)) {
    const score = scoreAction(state, action, me);
    if (score !== null && score > best) best = score;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Apprentice: softmax over one ply
// ---------------------------------------------------------------------------

/**
 * The Apprentice's random stream.
 *
 * Derived from `state.rngSeed` and `state.turn` so that the same position always
 * plays the same way — a replay of a game is the same game, and the tests can
 * pin a choice. The turn is mixed in with a large odd multiplier so consecutive
 * turns get unrelated streams rather than neighbouring seeds.
 */
function apprenticeSeed(state: GameState): number {
  return (state.rngSeed ^ Math.imul(state.turn, 0x9e3779b1)) >>> 0;
}

/**
 * Pick softly rather than greedily: the better a move scores, the likelier it is
 * chosen, but the best one is not certain.
 *
 * The infinities `evaluate` reports for a decided game are first brought onto
 * the scale of this position — a win sits {@link APPRENTICE_WIN_EDGE} above the
 * best real line, a loss {@link APPRENTICE_LOSS_EDGE} below the worst — and the
 * softmax runs on that. Anchoring to the candidates rather than to a constant is
 * what keeps "lethal" distinguishable from "a very good attack": the raw scores
 * of a position drift with the life totals and the board, and a fixed ceiling
 * would eventually clamp both to the same number and have the Apprentice miss
 * lethal nine times in ten.
 */
function chooseApprentice(state: GameState, me: PlayerId, candidates: readonly Action[]): Action {
  const raw: { action: Action; score: number }[] = [];
  let finiteMax = -Infinity;
  let finiteMin = Infinity;

  for (const action of candidates) {
    const score = scoreAction(state, action, me);
    if (score === null || Number.isNaN(score)) continue;
    raw.push({ action, score });
    if (Number.isFinite(score)) {
      if (score > finiteMax) finiteMax = score;
      if (score < finiteMin) finiteMin = score;
    }
  }
  if (raw.length === 0) return fallback(candidates);

  // Every line decided one way or the other: there is nothing to scale against,
  // so the choice is uniform over them.
  if (!Number.isFinite(finiteMax)) {
    finiteMax = 0;
    finiteMin = 0;
  }
  const winning = finiteMax + APPRENTICE_WIN_EDGE;
  const losing = finiteMin - APPRENTICE_LOSS_EDGE;
  const onScale = (score: number): number =>
    score === Infinity ? winning : score === -Infinity ? losing : score;

  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const entry of raw) {
    const score = onScale(entry.score);
    if (isBetter(score, entry.action, bestScore, best)) {
      best = entry.action;
      bestScore = score;
    }
  }
  if (best === null) return fallback(candidates);

  const weighted: { action: Action; weight: number }[] = [];
  let total = 0;
  for (const entry of raw) {
    const weight = Math.exp((onScale(entry.score) - bestScore) / APPRENTICE_TEMPERATURE);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    total += weight;
    weighted.push({ action: entry.action, weight });
  }
  if (total <= 0 || !Number.isFinite(total)) return best;

  const rng = makeRng(apprenticeSeed(state));
  let roll = rng() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.action;
  }
  return weighted[weighted.length - 1]?.action ?? best;
}

// ---------------------------------------------------------------------------
// Magician: argmax over one ply
// ---------------------------------------------------------------------------

/** The best move by the evaluator alone, ties going to the more committed attack. */
function chooseMagician(state: GameState, me: PlayerId, candidates: readonly Action[]): Action {
  let best: Action | null = null;
  let bestScore = -Infinity;

  for (const action of candidates) {
    const score = scoreAction(state, action, me);
    if (score === null) continue;
    if (isBetter(score, action, bestScore, best)) {
      best = action;
      bestScore = score;
    }
  }
  return best ?? fallback(candidates);
}

// ---------------------------------------------------------------------------
// Archmage: iterative-deepening alpha-beta to two ply
// ---------------------------------------------------------------------------

/**
 * Minimax with alpha-beta, from `me`'s point of view.
 *
 * Whose node this is comes from `state.priority`, not from alternation: this
 * engine hands priority back to the active player after most actions, so a
 * player often moves twice in a row (play a land, then cast). Reading the mover
 * off the state means the search models the game's real turn structure — a
 * maximising node followed by another maximising node — instead of pretending
 * the players alternate. Alpha-beta stays correct either way: a max node raises
 * alpha, a min node lowers beta, and a cut happens when they cross.
 *
 * The opponent is modelled with `evaluate` itself. Nothing else could be true to
 * spec §7: one evaluator, shared by every tier and by both sides of the search.
 *
 * The budget is checked on entering a node and again before expanding each
 * child, so the longest the search can run past its deadline is one
 * `legalActions` call plus one `reduce`. Expiry throws {@link BUDGET_EXPIRED},
 * which the root turns into "play the best move from the last completed depth".
 */
function search(
  state: GameState,
  me: PlayerId,
  depth: number,
  alpha: number,
  beta: number,
  deadline: number,
): number {
  if (depth <= 0 || state.winner !== null) return scoreOf(state, me);
  if (performance.now() >= deadline) throw BUDGET_EXPIRED;

  const candidates = pickCandidates(legalActions(state), MAX_REPLY_CANDIDATES);
  const maximizing = state.priority === me;

  let best = maximizing ? -Infinity : Infinity;
  let scored = 0;
  let low = alpha;
  let high = beta;

  for (const action of candidates) {
    if (performance.now() >= deadline) throw BUDGET_EXPIRED;

    const next = safeReduce(state, action);
    if (next === null) continue;

    const value = search(next, me, depth - 1, low, high, deadline);
    scored += 1;

    if (maximizing) {
      if (value > best) best = value;
      if (best > low) low = best;
    } else {
      if (value < best) best = value;
      if (best < high) high = best;
    }
    if (low >= high) break;
  }

  // A node with nothing to do — the game is over, or the generator offered only
  // actions the engine refused — is worth what it already is.
  return scored === 0 ? scoreOf(state, me) : best;
}

/**
 * Search one ply, then two, keeping the best answer from the last depth that
 * finished inside the budget.
 *
 * Iterative deepening is what makes the time budget safe rather than lossy: the
 * one-ply pass is fast and always completes, so there is always a real answer to
 * fall back on — and that answer is exactly what the Magician tier would have
 * played. An Archmage that runs out of clock degrades to a Magician, never to a
 * random move and never to a stalled UI.
 *
 * Each pass also reorders the root by what the previous pass thought, so the
 * two-ply pass examines the most promising move first and alpha-beta has
 * something to cut against.
 */
function chooseArchmage(state: GameState, me: PlayerId, candidates: readonly Action[]): Action {
  const deadline = performance.now() + ARCHMAGE_BUDGET_MS;
  let ordered = [...candidates];
  let answer = fallback(candidates);
  let settled = false;

  for (let depth = 1; depth <= ARCHMAGE_MAX_DEPTH; depth++) {
    const scored: { action: Action; value: number }[] = [];
    let expired = false;
    let alpha = -Infinity;

    for (const action of ordered) {
      if (performance.now() >= deadline) {
        expired = true;
        break;
      }

      const next = safeReduce(state, action);
      if (next === null) continue;

      let value: number;
      try {
        value = search(next, me, depth - 1, alpha, Infinity, deadline);
      } catch (err) {
        if (err !== BUDGET_EXPIRED) throw err;
        expired = true;
        break;
      }

      scored.push({ action, value });
      if (value > alpha) alpha = value;
    }

    // A partial pass is trusted only when nothing better exists yet: its moves
    // were searched in the previous depth's order, so its best-so-far is a real
    // answer, but a completed shallower search is a better one.
    if (scored.length > 0 && (!expired || !settled)) {
      let best: Action | null = null;
      let bestValue = -Infinity;
      for (const entry of scored) {
        if (isBetter(entry.value, entry.action, bestValue, best)) {
          best = entry.action;
          bestValue = entry.value;
        }
      }
      if (best !== null) {
        answer = best;
        settled = settled || !expired;
        ordered = [...scored]
          .sort((a, b) => b.value - a.value)
          .map((entry) => entry.action)
          .concat(ordered.filter((action) => !scored.some((entry) => entry.action === action)));
      }
    }

    if (expired) break;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

/**
 * What the bot does now, playing for whoever holds priority.
 *
 * The returned action is always one `legalActions(state)` offered, so the caller
 * can hand it straight to `reduce()`. The only exception is a position with no
 * legal actions at all — a finished game, which nothing should be asking about —
 * where a bare `pass` is returned rather than nothing at all.
 *
 * The search is wrapped: any throw from the engine costs the bot its search, not
 * its turn. It plays a legal move regardless.
 */
export function chooseAction(state: GameState, tier: Tier): Action {
  const options = legalActions(state);
  if (options.length === 0) return { kind: 'pass' };

  try {
    const me = state.priority;

    const land = landDrop(state, me, options);
    if (land !== null) return land;

    const candidates = pickCandidates(options, MAX_COMBAT_CANDIDATES);
    if (candidates.length === 0) return fallback(options);

    switch (tier) {
      case 'apprentice':
        return chooseApprentice(state, me, candidates);
      case 'magician':
        return chooseMagician(state, me, candidates);
      case 'archmage':
        return chooseArchmage(state, me, candidates);
    }
  } catch {
    return fallback(options);
  }
}
