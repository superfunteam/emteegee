import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  on: false,
  now: () => 0,
  reduceStamps: [] as number[],
  legalStamps: [] as number[],
}));

vi.mock('../../src/engine/rules', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/engine/rules')>('../../src/engine/rules');
  return {
    ...actual,
    reduce: (...args: Parameters<typeof actual.reduce>) => {
      if (probe.on) probe.reduceStamps.push(probe.now());
      return actual.reduce(...args);
    },
  };
});

vi.mock('../../src/engine/actions', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/engine/actions')>('../../src/engine/actions');
  return {
    ...actual,
    legalActions: (...args: Parameters<typeof actual.legalActions>) => {
      if (probe.on) probe.legalStamps.push(probe.now());
      return actual.legalActions(...args);
    },
  };
});

import { ARCHMAGE_BUDGET_MS, chooseAction } from '../../src/bot/magician';
import { legalActions } from '../../src/engine/actions';
import { reduce } from '../../src/engine/rules';
import { newInstance } from '../../src/engine/state';
import type { CardId, GameState, PlayerId } from '../../src/engine/types';
import { battlefield, giveLands } from '../fixtures';

function withLibraries(state: GameState, count = 20): GameState {
  let next = state;
  for (const player of [0, 1] as PlayerId[]) {
    for (let i = 0; i < count; i++) {
      next = newInstance(next, 'forest', player, 'library').state;
    }
  }
  return next;
}

function toHand(state: GameState, oracleId: string, player: PlayerId): { state: GameState; id: CardId } {
  return newInstance(state, oracleId, player, 'hand');
}

function heavyPosition(): GameState {
  let state = withLibraries(
    battlefield({
      you: Array.from({ length: 6 }, (_, i) => ({ power: 2 + (i % 3), toughness: 2 + (i % 2) })),
      them: Array.from({ length: 6 }, (_, i) => ({ power: 1 + (i % 3), toughness: 3 + (i % 2) })),
    }),
  );
  state = giveLands(state, 0, 'G', 4);
  for (let i = 0; i < 3; i++) state = toHand(state, 'giant-growth', 0).state;
  for (let i = 0; i < 2; i++) state = toHand(state, 'forest', 0).state;
  return state;
}

describe('overrun probe', () => {
  it('counts work performed after the archmage deadline', () => {
    const realNow = performance.now.bind(performance);
    probe.now = realNow;

    const positions: { label: string; state: GameState }[] = [];
    positions.push({ label: 'attacking side', state: heavyPosition() });

    const attacking = heavyPosition();
    const attack = legalActions(attacking).find(
      (action) => action.kind === 'declareAttackers' && action.attackers.length === 6,
    );
    positions.push({ label: 'blocking side', state: reduce(attacking, attack!).state });

    for (const { label, state } of positions) {
      // warm up
      chooseAction(state, 'archmage');

      probe.reduceStamps.length = 0;
      probe.legalStamps.length = 0;
      let firstNow: number | null = null;
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
        const t = realNow();
        if (probe.on && firstNow === null) firstNow = t;
        return t;
      });

      probe.on = true;
      const started = realNow();
      chooseAction(state, 'archmage');
      const elapsed = realNow() - started;
      probe.on = false;
      spy.mockRestore();

      expect(firstNow).not.toBeNull();
      const deadline = firstNow! + ARCHMAGE_BUDGET_MS;
      const reducesAfter = probe.reduceStamps.filter((t) => t >= deadline);
      const legalAfter = probe.legalStamps.filter((t) => t >= deadline);
      const lastStamp = Math.max(
        probe.reduceStamps[probe.reduceStamps.length - 1] ?? -Infinity,
        probe.legalStamps[probe.legalStamps.length - 1] ?? -Infinity,
      );

      console.log(
        `[${label}] elapsed=${elapsed.toFixed(2)}ms  totalReduce=${probe.reduceStamps.length}` +
          ` totalLegal=${probe.legalStamps.length}` +
          `  reducesPastDeadline=${reducesAfter.length}` +
          ` legalActionsPastDeadline=${legalAfter.length}` +
          `  overrun=${(lastStamp - deadline).toFixed(3)}ms`,
      );
    }
  }, 600_000);
});
