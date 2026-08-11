/**
 * Seeded randomness. The engine's only source of it.
 *
 * Every shuffle, every bot tiebreak, every random decision runs through a
 * generator made here and seeded from `GameState.rngSeed`. `Math.random` never
 * appears in the engine: a game is its seed plus its action log, and that is
 * what makes replay, undo, and the bot property tests possible.
 */

/** A generator of uniform values in [0, 1). Stateful; call it to advance. */
export type Rng = () => number;

/**
 * mulberry32 — a 32-bit generator with a full 2^32 period, chosen because it is
 * small, fast, and produces identical sequences in every JS runtime.
 *
 * The seed is coerced to a uint32, so 0, negatives, and values past 2^32 are all
 * accepted and land somewhere in range rather than producing NaN.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates, walking from the back so every permutation is equally likely.
 *
 * Pure with respect to `items`: the input is copied, never reordered in place.
 * The generator is the only thing that advances, which is what lets a caller
 * shuffle both libraries from one seeded stream and still reproduce the game.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const atI = out[i]!;
    const atJ = out[j]!;
    out[i] = atJ;
    out[j] = atI;
  }
  return out;
}
