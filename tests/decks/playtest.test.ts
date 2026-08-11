/**
 * The playtest: every deck against every other deck, bot against bot, in the
 * real engine.
 *
 * `decks.test.ts` checks that the six decks are legal objects — sixty cards, the
 * right lands, nothing off-color. That is a check on the *data*. This file is
 * the check no data test can make: that the decks and the engine agree when a
 * game is actually played. Six decks, fifteen pairings, several seeds each, each
 * game played to a winner one `reduce()` at a time.
 *
 * Three properties, in order of how much they would hurt if they broke:
 *
 * 1. **Nothing throws.** `reduce()` throws on an illegal action, and the bot
 *    only ever plays moves `legalActions` produced. So a throw anywhere in here
 *    is not a bot bug and not a deck bug — it is the engine offering a move it
 *    then refuses, which is the single assumption the whole design rests on
 *    (`magician.ts`, header). Note that `chooseAction` swallows engine throws
 *    inside its own search and falls back to a legal move, so the only throw
 *    that can reach this file is one from the move actually played.
 * 2. **Every game finishes.** A pairing that never ends is a pairing a player
 *    would sit in forever: two boards that cannot get through each other, and
 *    two libraries that somehow never run out. Capped at
 *    {@link TURN_LIMIT} turns, far above the ~40 a real game takes.
 * 3. **Every deck wins something.** A deck that cannot win a single game against
 *    any opponent on any seed is broken, whatever its card list says.
 *
 * Game length is *reported*, not asserted. A deck that always wins on turn four,
 * or a pairing that always grinds to turn forty, is a balance problem worth
 * seeing — but balance is a judgement call and a judgement call does not belong
 * in a red test. The summary prints at the end of the run.
 *
 * ## Why the seat alternates
 *
 * `createGame` puts the first decklist on the play, permanently (spec §3: player
 * 0 is the human and is always on the play). Being on the play is a real
 * advantage, so a pairing that only ever ran one way round would measure the
 * seat as much as the deck. Each pairing therefore alternates which deck starts
 * across its seeds, and every deck ends up on the play for half of its games.
 *
 * ## Why 'magician'
 *
 * The middle tier is the only one that is both deterministic and cheap. The
 * Apprentice deliberately plays a randomised second-best line, which would make
 * a "did this deck ever win" answer a coin flip; the Archmage spends up to
 * 120ms *per decision*, which on ninety games is minutes. The Magician is a
 * plain argmax over one ply: same evaluator, no clock, same answer every run.
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { Action, CardDef, GameState, OracleId } from '../../src/engine/types';
import { createGame } from '../../src/engine/state';
import { reduce } from '../../src/engine/rules';
import { chooseAction } from '../../src/bot/magician';
import { DECKS, deckList } from '../../src/decks';
import cardsJson from '../../src/data/cards.json';

const CARDS = cardsJson as unknown as Record<OracleId, CardDef>;

/** Deterministic, and the only tier that is. See the header. */
const TIER = 'magician' as const;

/**
 * The seeds each pairing is played on. Six is enough to catch a deck that only
 * wins on one lucky opener, and keeps the whole matrix — 15 pairings, 90 games —
 * inside a few seconds.
 */
const SEEDS = [1, 2, 3, 5, 8, 13] as const;

/** A game past this many turns is not a long game, it is a game that does not end. */
const TURN_LIMIT = 200;

/**
 * A second, tighter net: a game that stops advancing its turn counter while both
 * players keep taking priority would sit under {@link TURN_LIMIT} forever. No
 * real game comes close — the longest in this matrix takes a few hundred
 * actions.
 */
const ACTION_LIMIT = 20_000;

const DECK_IDS = Object.keys(DECKS);

// ---------------------------------------------------------------------------
// Playing a game
// ---------------------------------------------------------------------------

interface GameRecord {
  /** Deck id of the player in seat 0, who is on the play. */
  onPlay: string;
  /** Deck id of the player in seat 1. */
  onDraw: string;
  seed: number;
  /** Deck id of the winner, or `null` if the game hit a cap or threw. */
  winner: string | null;
  /** The turn the game ended on. */
  turns: number;
  /** How many actions were played, both sides together. */
  actions: number;
  /** Set only when `reduce` refused a move the bot handed it. */
  error: string | null;
}

/** Both decks, in the order they will be dealt, plus a label for the summary. */
interface Pairing {
  a: string;
  b: string;
  label: string;
}

const PAIRINGS: Pairing[] = (() => {
  const out: Pairing[] = [];
  for (let i = 0; i < DECK_IDS.length; i++) {
    for (let j = i + 1; j < DECK_IDS.length; j++) {
      const a = DECK_IDS[i]!;
      const b = DECK_IDS[j]!;
      out.push({ a, b, label: `${a} vs ${b}` });
    }
  }
  return out;
})();

/**
 * Play one game to the end and report what happened.
 *
 * The loop is the whole point: `chooseAction` for whoever holds priority,
 * `reduce` to apply it, repeat. Nothing here constructs an `Action` and nothing
 * here reaches into the state — this is exactly what the UI does when two bots
 * play, with the taps taken out.
 *
 * A throw is caught and recorded rather than thrown on, so one broken pairing
 * reports itself instead of hiding the other fourteen behind a stack trace.
 */
function playGame(onPlay: string, onDraw: string, seed: number): GameRecord {
  let state: GameState = createGame(
    CARDS,
    deckList(DECKS[onPlay]!),
    deckList(DECKS[onDraw]!),
    seed,
  );
  let actions = 0;
  let last: Action | null = null;

  try {
    while (state.winner === null && state.turn <= TURN_LIMIT && actions < ACTION_LIMIT) {
      last = chooseAction(state, TIER);
      state = reduce(state, last).state;
      actions += 1;
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      onPlay,
      onDraw,
      seed,
      winner: null,
      turns: state.turn,
      actions,
      error: `turn ${state.turn} ${state.phase}, playing ${JSON.stringify(last)}: ${why}`,
    };
  }

  return {
    onPlay,
    onDraw,
    seed,
    winner: state.winner === null ? null : state.winner === 0 ? onPlay : onDraw,
    turns: state.turn,
    actions,
    error: null,
  };
}

/**
 * The whole matrix, played once at module load.
 *
 * Module level rather than a `beforeAll` because every test in this file reads
 * the same ninety games and none of them should pay to replay them — the same
 * shape as `magician.test.ts`, which builds its two thousand positions the same
 * way. Everything is seeded, so this is the same ninety games on every run.
 */
const GAMES: Map<string, GameRecord[]> = (() => {
  const out = new Map<string, GameRecord[]>();
  for (const pairing of PAIRINGS) {
    const records: GameRecord[] = [];
    for (let i = 0; i < SEEDS.length; i++) {
      // Alternate the seat so neither deck is measured purely on being first.
      const onPlay = i % 2 === 0 ? pairing.a : pairing.b;
      const onDraw = i % 2 === 0 ? pairing.b : pairing.a;
      records.push(playGame(onPlay, onDraw, SEEDS[i]!));
    }
    out.set(pairing.label, records);
  }
  return out;
})();

const ALL_GAMES: GameRecord[] = [...GAMES.values()].flat();

const describeGame = (game: GameRecord): string =>
  `${game.onPlay} (play) vs ${game.onDraw} seed ${game.seed}`;

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe('the playtest matrix', () => {
  it('plays every one of the fifteen pairings', () => {
    expect(PAIRINGS).toHaveLength(15);
    expect(GAMES.size).toBe(15);
  });

  it('plays every pairing on several distinct seeds', () => {
    expect(new Set(SEEDS).size).toBe(SEEDS.length);
    expect(SEEDS.length).toBeGreaterThanOrEqual(4);
    for (const [label, records] of GAMES) {
      expect(records, label).toHaveLength(SEEDS.length);
    }
  });

  it('puts each deck on the play in half of its games', () => {
    for (const id of DECK_IDS) {
      const played = ALL_GAMES.filter((game) => game.onPlay === id || game.onDraw === id);
      const onPlay = played.filter((game) => game.onPlay === id);
      expect(played.length, id).toBe((DECK_IDS.length - 1) * SEEDS.length);
      expect(onPlay.length, id).toBe(played.length / 2);
    }
  });
});

// ---------------------------------------------------------------------------
// The three properties
// ---------------------------------------------------------------------------

describe('no game throws', () => {
  it('never hands reduce() a move legalActions did not offer', () => {
    // `reduce` throws on an illegal action, so a failure here says the engine
    // offered something it then refused. That is an engine bug, not a deck one.
    const thrown = ALL_GAMES.filter((game) => game.error !== null).map(
      (game) => `${describeGame(game)}: ${game.error}`,
    );
    expect(thrown).toEqual([]);
  });
});

describe('every game finishes', () => {
  it('produces a winner in every game', () => {
    const undecided = ALL_GAMES.filter((game) => game.winner === null).map(
      (game) => `${describeGame(game)} ended with no winner on turn ${game.turns}`,
    );
    expect(undecided).toEqual([]);
  });

  it(`finishes every game inside ${TURN_LIMIT} turns`, () => {
    const overlong = ALL_GAMES.filter((game) => game.turns > TURN_LIMIT).map(
      (game) => `${describeGame(game)} reached turn ${game.turns}`,
    );
    expect(overlong).toEqual([]);
  });

  it('never hits the action cap', () => {
    // Separate from the turn limit: a game that stalls without advancing the
    // turn counter would pass the turn check and still never end.
    const stalled = ALL_GAMES.filter((game) => game.actions >= ACTION_LIMIT).map(
      (game) => `${describeGame(game)} played ${game.actions} actions`,
    );
    expect(stalled).toEqual([]);
  });

  it('gives the win to one of the two decks that played', () => {
    for (const game of ALL_GAMES) {
      expect([game.onPlay, game.onDraw], describeGame(game)).toContain(game.winner);
    }
  });
});

describe('every deck can win', () => {
  it('wins at least one game with each of the six decks', () => {
    const winless = DECK_IDS.filter(
      (id) => !ALL_GAMES.some((game) => game.winner === id),
    ).map((id) => {
      const played = ALL_GAMES.filter((g) => g.onPlay === id || g.onDraw === id).length;
      return `${id} lost all ${played} of its games`;
    });
    expect(winless).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const mean = (numbers: number[]): number =>
  numbers.length === 0 ? 0 : numbers.reduce((a, b) => a + b, 0) / numbers.length;

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

/**
 * Print the balance picture: how long each pairing takes, and how each deck
 * fares. Deliberately a `console.log` and not an assertion — see the header.
 */
afterAll(() => {
  const lines: string[] = [];
  const decided = ALL_GAMES.filter((game) => game.winner !== null);

  lines.push('');
  lines.push(
    `playtest: ${ALL_GAMES.length} games, ${PAIRINGS.length} pairings x ${SEEDS.length} seeds, tier "${TIER}"`,
  );
  lines.push('');
  lines.push(`  ${pad('pairing', 24)}${pad('avg turns', 11)}${pad('range', 11)}record`);

  const width = Math.max(...DECK_IDS.map((id) => id.length));
  for (const pairing of PAIRINGS) {
    const records = GAMES.get(pairing.label) ?? [];
    const turns = records.map((game) => game.turns);
    const aWins = records.filter((game) => game.winner === pairing.a).length;
    const bWins = records.filter((game) => game.winner === pairing.b).length;
    lines.push(
      `  ${pad(pairing.label, 24)}${pad(mean(turns).toFixed(1), 11)}` +
        `${pad(`${Math.min(...turns)}-${Math.max(...turns)}`, 11)}` +
        `${pad(pairing.a, width)} ${aWins}-${bWins} ${pairing.b}`,
    );
  }

  lines.push('');
  lines.push(`  ${pad('deck', 24)}${pad('wins', 11)}${pad('win rate', 11)}avg turns when it wins`);
  for (const id of DECK_IDS) {
    const played = ALL_GAMES.filter((game) => game.onPlay === id || game.onDraw === id);
    const won = played.filter((game) => game.winner === id);
    lines.push(
      `  ${pad(id, 24)}${pad(`${won.length}/${played.length}`, 11)}` +
        `${pad(`${Math.round((100 * won.length) / played.length)}%`, 11)}` +
        `${won.length === 0 ? '-' : mean(won.map((game) => game.turns)).toFixed(1)}`,
    );
  }

  lines.push('');
  lines.push(
    `  overall: average game ${mean(decided.map((game) => game.turns)).toFixed(1)} turns, ` +
      `shortest ${Math.min(...decided.map((game) => game.turns))}, ` +
      `longest ${Math.max(...decided.map((game) => game.turns))}`,
  );
  lines.push('');

  console.log(lines.join('\n'));
});
