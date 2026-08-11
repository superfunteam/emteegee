/**
 * The bot's acceptance criteria, per spec §7.
 *
 * The first test is the one that matters most and it is a property, not an
 * example: across two thousand positions reached by actually playing the game,
 * every tier's answer is a move `legalActions` offered. That is the claim "the
 * bot cannot cheat", checked rather than asserted — and because the positions
 * are reached by playing random *legal* moves from a fresh game, they are boards
 * this game can really produce, not hand-built ones chosen to be easy.
 *
 * The rest pin the three tiers apart: the Magician finds lethal, the Apprentice
 * is random but reproducible, the Archmage sees one move further and stops when
 * its clock runs out.
 */

import { describe, expect, it } from 'vitest';
import { ARCHMAGE_BUDGET_MS, chooseAction, type Tier } from '../../src/bot/magician';
import { isLegal, legalActions } from '../../src/engine/actions';
import { reduce } from '../../src/engine/rules';
import { cloneState, createGame, isCreature, newInstance } from '../../src/engine/state';
import { makeRng } from '../../src/engine/rng';
import type { Action, CardId, GameState, PlayerId } from '../../src/engine/types';
import { TEST_DECK, TEST_DEFS, battlefield, giveLands } from '../fixtures';

const TIERS: readonly Tier[] = ['apprentice', 'magician', 'archmage'];

// ---------------------------------------------------------------------------
// Building positions
// ---------------------------------------------------------------------------

/**
 * Give both players a library.
 *
 * `battlefield()` and `gameWith()` leave libraries empty, and an empty library
 * is a loss the moment its owner draws — so on those boards *every* line the bot
 * looks at ends in somebody winning, and a test would be reading a deck-out
 * rather than a decision. Twenty cards is more than any test here draws.
 */
function withLibraries(state: GameState, count = 20): GameState {
  let next = state;
  for (const player of [0, 1] as PlayerId[]) {
    for (let i = 0; i < count; i++) {
      next = newInstance(next, 'forest', player, 'library').state;
    }
  }
  return next;
}

function atLife(state: GameState, you: number, them: number): GameState {
  const next = cloneState(state);
  next.players[0].life = you;
  next.players[1].life = them;
  return next;
}

/** Put a card in a player's hand and report where it landed. */
function toHand(state: GameState, oracleId: string, player: PlayerId): { state: GameState; id: CardId } {
  return newInstance(state, oracleId, player, 'hand');
}

/**
 * Is this action one `legalActions` offered for this position?
 *
 * By value, not by identity: the bot may return the very object the generator
 * built, but the property under test is membership, and a future implementation
 * that rebuilt an equal action would still be honest.
 */
function isOffered(state: GameState, action: Action): boolean {
  const wanted = JSON.stringify(action);
  return legalActions(state).some((candidate) => JSON.stringify(candidate) === wanted);
}

/** The type says an `Action` always comes back. This checks that it really does. */
function isReallyDefined(action: Action): boolean {
  return (action as Action | undefined) !== undefined && typeof action?.kind === 'string';
}

function creatures(state: GameState, player: PlayerId): number {
  return state.players[player].battlefield.filter((id) => isCreature(state, id)).length;
}

/**
 * Positions reached by playing random legal moves out of a fresh game.
 *
 * Reachable rather than synthetic on purpose: a hand-built state can be
 * incoherent in ways the engine never produces, and passing one to the bot tests
 * the fixture more than the bot. Every position here is one `createGame` plus a
 * sequence of `reduce` calls actually arrived at.
 *
 * A game is abandoned once either board passes seven creatures. Blocking
 * declarations grow with the product of the boards, and a random walk with a
 * sixty-card deck of nothing but bears eventually builds a board no real game
 * reaches — spending the whole test budget on one position.
 */
function reachablePositions(count: number): GameState[] {
  const out: GameState[] = [];
  const rng = makeRng(0x656d7467);

  for (let seed = 1; out.length < count; seed++) {
    let state = createGame(TEST_DEFS, TEST_DECK, TEST_DECK, seed);
    for (let step = 0; step < 200 && out.length < count; step++) {
      if (state.winner !== null) break;
      if (creatures(state, 0) > 7 || creatures(state, 1) > 7) break;

      out.push(state);
      const options = legalActions(state);
      const choice = options[Math.floor(rng() * options.length)];
      if (!choice) break;
      state = reduce(state, choice).state;
    }
  }
  return out;
}

const POSITIONS = reachablePositions(2000);

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('chooseAction: the bot can only play moves the engine offered', () => {
  it('reaches a variety of positions to test against', () => {
    expect(POSITIONS).toHaveLength(2000);
    const phases = new Set(POSITIONS.map((state) => state.phase));
    expect(phases.size).toBeGreaterThan(3);
    expect(POSITIONS.some((state) => state.priority === 1)).toBe(true);
    expect(POSITIONS.some((state) => state.phase === 'declareBlockers')).toBe(true);
  });

  it('returns a member of legalActions for every tier, in all 2000 positions', () => {
    const failures: string[] = [];

    for (const state of POSITIONS) {
      for (const tier of TIERS) {
        const action = chooseAction(state, tier);

        if (!isReallyDefined(action)) {
          failures.push(`${tier} returned nothing at turn ${state.turn} ${state.phase}`);
          continue;
        }
        if (!isOffered(state, action)) {
          failures.push(`${tier} played an unoffered ${JSON.stringify(action)} in ${state.phase}`);
        }
        if (!isLegal(state, action)) {
          failures.push(`${tier} played an illegal ${JSON.stringify(action)} in ${state.phase}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 240_000);

  it('never touches the position it is given', () => {
    for (const state of POSITIONS.slice(0, 60)) {
      const snapshot = JSON.stringify(state);
      for (const tier of TIERS) chooseAction(state, tier);
      expect(JSON.stringify(state)).toBe(snapshot);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Lethal
// ---------------------------------------------------------------------------

/** Three 3/3s against nine life, with the only creature in the way already tapped. */
function lethalBoard(): GameState {
  return atLife(
    withLibraries(
      battlefield({
        you: [
          { power: 3, toughness: 3 },
          { power: 3, toughness: 3 },
          { power: 3, toughness: 3 },
        ],
        them: [{ power: 1, toughness: 1, tapped: true }],
      }),
    ),
    20,
    9,
  );
}

describe('the Magician takes lethal when lethal is on the board', () => {
  it('attacks with everything when exactly everything is lethal', () => {
    const state = lethalBoard();
    const action = chooseAction(state, 'magician');

    expect(action.kind).toBe('declareAttackers');
    expect(isLegal(state, action)).toBe(true);
    expect(reduce(state, action).state.winner).toBe(0);
  });

  it('still sees lethal with a trick in hand, though the damage step stops for it', () => {
    // A held instant makes the first-strike step a real decision, so the engine
    // stops there rather than dealing damage. A bot that scored the position at
    // that stop would see an attack that had not hurt anybody yet, and would
    // rate lethal as worth nothing at all.
    let state = giveLands(lethalBoard(), 0, 'G', 1);
    state = toHand(state, 'giant-growth', 0).state;

    const action = chooseAction(state, 'magician');
    expect(action.kind === 'declareAttackers' && action.attackers).toHaveLength(3);

    // The stop this test exists for, and then the damage nobody interrupted.
    let after = reduce(state, action).state;
    expect(after.phase).toBe('firstStrikeDamage');
    expect(after.winner).toBeNull();

    for (let i = 0; i < 4 && after.winner === null; i++) {
      const passing = legalActions(after).find((option) => option.kind === 'pass');
      if (!passing) break;
      after = reduce(after, passing).state;
    }
    expect(after.winner).toBe(0);
  });

  it('finds the one lethal attack on a board wide enough to be sampled', () => {
    // Eight attackers into sixteen life: every attack but the all-in comes up
    // short, so this fails the moment a candidate cap drops the full attack.
    const state = atLife(
      withLibraries(
        battlefield({
          you: Array.from({ length: 8 }, () => ({ power: 2, toughness: 2 })),
          them: [{ power: 4, toughness: 4, tapped: true }],
        }),
      ),
      20,
      16,
    );

    const action = chooseAction(state, 'magician');
    expect(action.kind).toBe('declareAttackers');
    expect(action.kind === 'declareAttackers' && action.attackers).toHaveLength(8);
    expect(reduce(state, action).state.winner).toBe(0);
  });

  it('is taken by the Archmage too', () => {
    const state = lethalBoard();
    const action = chooseAction(state, 'archmage');
    expect(reduce(state, action).state.winner).toBe(0);
  });

  it('does not imagine lethal through a wall of untapped blockers', () => {
    // The same three attackers, but everything can block. Nothing here wins this
    // turn, so no tier may report a decided game by attacking into it.
    const state = atLife(
      withLibraries(
        battlefield({
          you: [
            { power: 3, toughness: 3 },
            { power: 3, toughness: 3 },
            { power: 3, toughness: 3 },
          ],
          them: [
            { power: 3, toughness: 3 },
            { power: 3, toughness: 3 },
            { power: 3, toughness: 3 },
          ],
        }),
      ),
      20,
      9,
    );

    for (const tier of TIERS) {
      const action = chooseAction(state, tier);
      expect(isLegal(state, action)).toBe(true);
      expect(reduce(state, action).state.winner).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

describe('blocking', () => {
  /** A 2/2 attacks into an untapped 3/3: the block kills it and survives. */
  function attackedByASmallerCreature(): GameState {
    const start = withLibraries(
      battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 3, toughness: 3 }] }),
    );
    const attack = legalActions(start).find(
      (action) => action.kind === 'declareAttackers' && action.attackers.length === 1,
    );
    expect(attack).toBeDefined();
    return reduce(start, attack!).state;
  }

  it('hands the block decision to the defender', () => {
    const state = attackedByASmallerCreature();
    expect(state.phase).toBe('declareBlockers');
    expect(state.priority).toBe(1);
  });

  it('takes a block that kills the attacker and survives it, on every tier', () => {
    const state = attackedByASmallerCreature();

    for (const tier of TIERS) {
      const action = chooseAction(state, tier);
      expect(action.kind, tier).toBe('declareBlockers');
      expect(action.kind === 'declareBlockers' && action.blocks, tier).toHaveLength(1);

      const after = reduce(state, action).state;
      expect(after.cards['you0']?.zone, tier).toBe('graveyard');
      expect(after.cards['them0']?.zone, tier).toBe('battlefield');
      expect(after.players[1].life, tier).toBe(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The land drop
// ---------------------------------------------------------------------------

describe('the land drop', () => {
  it('plays a land instead of passing, though the evaluator prices it as a loss', () => {
    // A card in hand scores 1.5 and an untapped land 0.5, so every greedy search
    // refuses this move — and a bot that refuses it never casts anything again.
    let state = withLibraries(battlefield({ you: [], them: [] }));
    state = toHand(state, 'forest', 0).state;
    state = toHand(state, 'grizzly-bears', 0).state;
    const main = cloneState(state);
    main.phase = 'main1';

    for (const tier of TIERS) {
      const action = chooseAction(main, tier);
      expect(action.kind, tier).toBe('playLand');
      expect(isLegal(main, action), tier).toBe(true);
    }
  });

  it('then spends it on the creature it paid for', () => {
    let state = giveLands(withLibraries(battlefield({ you: [], them: [] })), 0, 'G', 1);
    const bear = toHand(state, 'grizzly-bears', 0);
    state = toHand(bear.state, 'forest', 0).state;
    const main = cloneState(state);
    main.phase = 'main1';

    const land = chooseAction(main, 'magician');
    expect(land.kind).toBe('playLand');

    const after = reduce(main, land).state;
    const cast = chooseAction(after, 'magician');
    expect(cast.kind).toBe('castSpell');
    expect(cast.kind === 'castSpell' && cast.card).toBe(bear.id);
  });

  it('plays the land that casts what is in hand', () => {
    // An Island cannot pay for Giant Growth and a Forest can, and the bot finds
    // that out by looking one move past the land drop rather than by knowing it.
    let state = giveLands(withLibraries(battlefield({ you: [{ power: 2, toughness: 2 }], them: [] })), 0, 'U', 1);
    const forest = toHand(state, 'forest', 0);
    state = toHand(forest.state, 'island', 0).state;
    state = toHand(state, 'giant-growth', 0).state;
    const main = cloneState(state);
    main.phase = 'main1';

    const action = chooseAction(main, 'magician');
    expect(action.kind).toBe('playLand');
    expect(action.kind === 'playLand' && action.card).toBe(forest.id);
  });
});

// ---------------------------------------------------------------------------
// Apprentice
// ---------------------------------------------------------------------------

describe('the Apprentice', () => {
  it('is deterministic for a fixed position', () => {
    const state = lethalBoard();
    const first = JSON.stringify(chooseAction(state, 'apprentice'));
    for (let i = 0; i < 40; i++) {
      expect(JSON.stringify(chooseAction(state, 'apprentice'))).toBe(first);
    }
  });

  it('plays two identical positions identically, however they were built', () => {
    const state = lethalBoard();
    const copy = cloneState(state);
    expect(JSON.stringify(chooseAction(copy, 'apprentice'))).toBe(
      JSON.stringify(chooseAction(state, 'apprentice')),
    );
  });

  it('plays a different turn differently, from the same board', () => {
    // The stream is seeded from the seed *and* the turn, so a position revisited
    // on a later turn is not a rerun of the same coin flip.
    const base = lethalBoard();
    const picks = new Set<string>();
    for (let turn = 1; turn <= 12; turn++) {
      const state = cloneState(base);
      state.turn = turn;
      picks.add(JSON.stringify(chooseAction(state, 'apprentice')));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('takes lethal most of the time, and misses it some of the time', () => {
    let found = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const state = cloneState(lethalBoard());
      state.rngSeed = i * 7919 + 3;
      state.turn = 1 + (i % 5);
      if (reduce(state, chooseAction(state, 'apprentice')).state.winner === 0) found += 1;
    }
    expect(found).toBeGreaterThan(trials / 2);
    expect(found).toBeLessThan(trials);
  }, 30_000);

  it('disagrees with the Magician often enough to be a different opponent', () => {
    const base = atLife(lethalBoard(), 20, 30);
    let differed = 0;
    for (let i = 0; i < 100; i++) {
      const state = cloneState(base);
      state.rngSeed = i * 104729 + 11;
      const soft = JSON.stringify(chooseAction(state, 'apprentice'));
      const hard = JSON.stringify(chooseAction(state, 'magician'));
      if (soft !== hard) differed += 1;
    }
    expect(differed).toBeGreaterThan(5);
    expect(differed).toBeLessThan(100);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Archmage
// ---------------------------------------------------------------------------

/** Six against six, with tricks and mana in hand: the widest search this game asks for. */
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

describe('the Archmage', () => {
  it('answers inside its time budget, with generous headroom for a slow machine', () => {
    const state = heavyPosition();
    // Warm the engine's code paths so the first run is not measuring the JIT.
    chooseAction(state, 'magician');

    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const action = chooseAction(state, 'archmage');
      const elapsed = performance.now() - started;

      expect(isLegal(state, action)).toBe(true);
      expect(elapsed).toBeLessThan(ARCHMAGE_BUDGET_MS * 10);
    }
  }, 60_000);

  it('answers inside its budget on the blocking side of the same board too', () => {
    const attacking = heavyPosition();
    const attack = legalActions(attacking).find(
      (action) => action.kind === 'declareAttackers' && action.attackers.length === 6,
    );
    expect(attack).toBeDefined();
    const state = reduce(attacking, attack!).state;

    const started = performance.now();
    const action = chooseAction(state, 'archmage');
    expect(performance.now() - started).toBeLessThan(ARCHMAGE_BUDGET_MS * 10);
    expect(isLegal(state, action)).toBe(true);
  }, 60_000);

  it('declines an attack the defender would simply eat, which one ply cannot see', () => {
    // A 2/2 into an untapped 5/5. One ply stops at the declare-blockers step and
    // sees an attack and a decline as the same position; two plies see the block.
    const state = withLibraries(
      battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 5, toughness: 5 }] }),
    );

    const magician = chooseAction(state, 'magician');
    const archmage = chooseAction(state, 'archmage');

    expect(magician.kind === 'declareAttackers' && magician.attackers).toHaveLength(1);
    expect(archmage.kind === 'declareAttackers' && archmage.attackers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Never nothing
// ---------------------------------------------------------------------------

describe('chooseAction always answers', () => {
  it('returns an action for every tier in a position with nothing to do', () => {
    const state = withLibraries(battlefield({ you: [], them: [] }));
    const idle = cloneState(state);
    idle.phase = 'main1';

    for (const tier of TIERS) {
      const action = chooseAction(idle, tier);
      expect(isReallyDefined(action), tier).toBe(true);
      expect(isLegal(idle, action), tier).toBe(true);
    }
  });

  it('answers a decided game with a pass rather than with nothing', () => {
    const over = cloneState(withLibraries(battlefield({ you: [], them: [] })));
    over.winner = 0;
    expect(legalActions(over)).toEqual([]);

    for (const tier of TIERS) {
      const action = chooseAction(over, tier);
      expect(isReallyDefined(action), tier).toBe(true);
      expect(action.kind, tier).toBe('pass');
    }
  });

  it('answers when the stack is full and passing is the only move', () => {
    let state = withLibraries(battlefield({ you: [{ power: 2, toughness: 2 }], them: [] }));
    state = giveLands(state, 0, 'G', 6);
    for (let i = 0; i < 3; i++) state = toHand(state, 'giant-growth', 0).state;

    const main = cloneState(state);
    main.phase = 'main1';

    // Cast until the stack is capped, then ask.
    let full = main;
    for (let i = 0; i < 3; i++) {
      const cast = legalActions(full).find((action) => action.kind === 'castSpell');
      if (!cast) break;
      full = reduce(full, cast).state;
    }

    for (const tier of TIERS) {
      const action = chooseAction(full, tier);
      expect(isReallyDefined(action), tier).toBe(true);
      expect(isLegal(full, action), tier).toBe(true);
    }
  });
});
