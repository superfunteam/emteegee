import { describe, it, expect } from 'vitest';
import { makeRng, shuffle } from '../../src/engine/rng';
import type { Rng } from '../../src/engine/rng';

/** Pull `n` values off a generator. */
function take(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng());
  return out;
}

const ascending = (a: number, b: number): number => a - b;

describe('makeRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces the same long sequence for the same seed', () => {
    expect(take(makeRng(1337), 500)).toEqual(take(makeRng(1337), 500));
  });

  it('produces a different sequence for a different seed', () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
    expect(take(makeRng(1), 10)).not.toEqual(take(makeRng(2), 10));
  });

  it('produces a different sequence for adjacent seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(take(makeRng(seed), 4)).not.toEqual(take(makeRng(seed + 1), 4));
    }
  });

  it('yields values in [0, 1)', () => {
    const rng = makeRng(9);
    for (const v of take(rng, 2000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('does not immediately repeat itself', () => {
    const values = take(makeRng(5), 1000);
    expect(new Set(values).size).toBe(values.length);
  });

  it('spreads roughly evenly across the unit interval', () => {
    const buckets = [0, 0, 0, 0];
    for (const v of take(makeRng(2026), 4000)) {
      const i = Math.min(3, Math.floor(v * 4));
      buckets[i] = buckets[i]! + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });

  it('treats each generator as independent state', () => {
    const a = makeRng(11);
    const b = makeRng(11);
    a();
    a();
    expect(b()).toEqual(makeRng(11)());
  });

  it('accepts seed 0 and negative seeds without producing NaN', () => {
    for (const seed of [0, -1, -123456, 2 ** 31, 4294967295]) {
      const values = take(makeRng(seed), 5);
      for (const v of values) {
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});

describe('shuffle', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];

  it('shuffles deterministically for a seed', () => {
    const x = shuffle(input, makeRng(7));
    const y = shuffle(input, makeRng(7));
    expect(x).toEqual(y);
  });

  it('preserves every element', () => {
    const x = shuffle(input, makeRng(7));
    expect([...x].sort(ascending)).toEqual(input);
    expect(x).toHaveLength(input.length);
  });

  it('actually reorders', () => {
    expect(shuffle(input, makeRng(7))).not.toEqual(input);
  });

  it('does not mutate its input', () => {
    const source = [...input];
    shuffle(source, makeRng(3));
    expect(source).toEqual(input);
  });

  it('returns a new array even when nothing could move', () => {
    const single = ['only'];
    const out = shuffle(single, makeRng(1));
    expect(out).toEqual(single);
    expect(out).not.toBe(single);
  });

  it('handles an empty array', () => {
    expect(shuffle([], makeRng(1))).toEqual([]);
  });

  it('produces different orders for different seeds', () => {
    const deck = Array.from({ length: 60 }, (_, i) => i);
    expect(shuffle(deck, makeRng(1))).not.toEqual(shuffle(deck, makeRng(2)));
  });

  it('preserves a 60-card multiset with duplicates', () => {
    const deck = Array.from({ length: 60 }, (_, i) => `card${i % 12}`);
    const out = shuffle(deck, makeRng(99));
    expect([...out].sort()).toEqual([...deck].sort());
  });

  it('consumes exactly one rng draw per element beyond the first', () => {
    let draws = 0;
    const base = makeRng(4);
    const counting: Rng = () => {
      draws++;
      return base();
    };
    shuffle(input, counting);
    expect(draws).toBe(input.length - 1);
  });

  it('reaches many distinct permutations across seeds', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      seen.add(shuffle(input, makeRng(seed)).join(','));
    }
    expect(seen.size).toBeGreaterThan(150);
  });

  it('does not bias the first position toward any one element', () => {
    const counts = new Map<number, number>();
    for (let seed = 0; seed < 2000; seed++) {
      const first = shuffle(input, makeRng(seed))[0]!;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    expect(counts.size).toBe(input.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(150);
      expect(count).toBeLessThan(350);
    }
  });

  it('accepts a readonly array', () => {
    const frozen: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
    const out = shuffle(frozen, makeRng(8));
    expect([...out].sort(ascending)).toEqual([...frozen]);
  });
});
