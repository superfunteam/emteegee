/**
 * The soak: complete games, played headlessly, one legal action at a time.
 *
 * `gaps.test.ts` proves each of the four closed gaps behaves correctly in a
 * position built to show it. This file proves the thing a unit test structurally
 * cannot: that none of them can *stop the game*. A mulligan, a scry, a floated
 * land and a damage assignment order are all moments where the engine stops and
 * waits for a decision — and a decision nobody can make is a hung tab, not a
 * failed assertion. So these games are played from the opening hand to a winner
 * with no bot and no heuristic at all, taking whatever `legalActions` offers.
 *
 * Four properties, and the second is the one this file exists for:
 *
 * 1. **Every game terminates with a winner** inside {@link TURN_LIMIT} turns.
 * 2. **`legalActions` is never empty while `winner` is null.** That is the exact
 *    shape of a hang: the game is waiting on a decision and offering no way to
 *    make it. It is checked at *every* state visited, not at the end — by the
 *    time a game has stalled there is nothing left to look at.
 * 3. **`reduce` never throws.** It throws on an illegal action, and this file
 *    only ever hands it something the generator just produced, so a throw here
 *    says the engine offered a move it then refused.
 * 4. **The four gaps are actually reached.** A soak that never scried would
 *    prove nothing about scrying, so the counts are asserted, not just printed.
 *
 * ## Why the policy prefers a non-pass move
 *
 * A player who only ever passes reaches turn one, an empty board, and a
 * decking-out fifty turns later, having exercised none of this. Preferring a
 * real move means lands get played, spells get cast, creatures attack and block,
 * mana gets floated by hand, and the four decisions actually come up. It is also
 * safe: every non-pass action is bounded within a turn — a land can be tapped
 * once, a card cast once, an ability paid for out of a finite pool, a
 * declaration made once, an order set once — so preferring them cannot keep a
 * phase from ending.
 *
 * Choices among the non-pass moves are made by a seeded generator, so all of
 * this is one fixed computation: the same games, the same numbers, every run.
 *
 * ## Why the blocks are widened
 *
 * Blocks are the one place this file offers itself a move `legalActions` did not
 * enumerate, and it has to. Ordering blockers is a decision the attacking player
 * only owes when one attacker is blocked by two or more creatures, and the
 * candidate blocks the generator offers only ever gang up on a *menace*
 * attacker — deliberately, since the space of assignments is
 * `(1 + attackers)^blockers` and `validateBlocks` is the real definition of
 * legal (see the header of `actions.ts`). No card in the pool has menace. So a
 * soak that picked only from the candidate list would never gang-block, never
 * reach `firstStrikeDamage` with an order to set, and would prove exactly
 * nothing about the fourth gap.
 *
 * {@link gangBlocks} therefore builds the double blocks a human would build by
 * dragging two creatures onto one attacker, and every one of them is put through
 * `isLegal` before it is played. Nothing illegal is ever handed to `reduce` —
 * which is the property being tested, and which `reduce` would throw about
 * anyway.
 *
 * ## Where the scries and the mulligans come from
 *
 * None of the six decks plays a scry card — Opt and Preordain are in the pool
 * and in no decklist — so a soak over the real decks would never set
 * `pendingScry` at all. {@link SCRY_DECK} is built for this file out of pool
 * cards, and the plans that use it also *force* a scry spell and an Island into
 * the opening hand, so the decision is reached rather than hoped for.
 *
 * The mulligan is forced the same way: each plan names how many mulligans each
 * player takes, the policy takes exactly that many, and the resulting opening
 * hand size is asserted — a London keep that failed to bottom its cards would
 * show up as a seven-card hand after two mulligans.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type {
  Action,
  CardDef,
  CardId,
  GameState,
  OracleId,
  PlayerId,
} from '../../src/engine/types';
import { MAX_MULLIGANS, STARTING_HAND } from '../../src/engine/types';
import { inMulligan, isLegal, legalActions } from '../../src/engine/actions';
import { beginMulligans, reduce } from '../../src/engine/rules';
import { cloneState, createGame, isCreature, opponentOf } from '../../src/engine/state';
import { makeRng, type Rng } from '../../src/engine/rng';
import { DECKS, deckList } from '../../src/decks';
import cardsJson from '../../src/data/cards.json';

const CARDS = cardsJson as unknown as Record<OracleId, CardDef>;

/** A game past this many turns is not a long game, it is a game that does not end. */
const TURN_LIMIT = 300;

/**
 * A second, tighter net. A game that stalls without advancing its turn counter —
 * two players handing priority back and forth forever — would sit under
 * {@link TURN_LIMIT} for as long as the process lived. The longest game in this
 * soak plays a few thousand actions.
 */
const ACTION_LIMIT = 60_000;

const DECK_IDS = Object.keys(DECKS);

// ---------------------------------------------------------------------------
// The scry deck
// ---------------------------------------------------------------------------

/**
 * Mono-blue, sixteen scry spells, twenty-four Islands.
 *
 * Built here rather than in `src/decks` on purpose: it is a test instrument, not
 * a deck a player would be offered. Every id is a pool card, so `cards.json` has
 * a real definition for all of it and the games it plays are real games — the
 * fliers are there so a scry deck can still win by attacking rather than only by
 * decking its opponent out.
 */
const SCRY_DECK: OracleId[] = expand([
  ['island', 24],
  ['opt', 8],
  ['preordain', 8],
  ['storm-crow', 4],
  ['coral-merfolk', 4],
  ['wind-drake', 4],
  ['snapping-drake', 4],
  ['air-elemental', 4],
]);

function expand(entries: [OracleId, number][]): OracleId[] {
  const out: OracleId[] = [];
  for (const [oracleId, count] of entries) {
    for (let i = 0; i < count; i++) out.push(oracleId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One game to play: two decks, a seed, and what to force before it starts. */
interface Plan {
  family: string;
  label: string;
  seed: number;
  deckA: OracleId[];
  deckB: OracleId[];
  /** How many mulligans each player takes before keeping. */
  mulligans: [number, number];
  /** A card put into each player's opening hand, when the plan wants one there. */
  forced: [OracleId[], OracleId[]];
}

const NOTHING_FORCED: [OracleId[], OracleId[]] = [[], []];

const MULLIGAN_PLANS: [number, number][] = [
  [1, 0],
  [0, 1],
  [2, 1],
  [1, 3],
  [3, 3],
  [3, 0],
  [0, 2],
  [2, 2],
];

/** Every pairing of the six decks, in a stable order. */
const PAIRINGS: [string, string][] = (() => {
  const out: [string, string][] = [];
  for (let i = 0; i < DECK_IDS.length; i++) {
    for (let j = i + 1; j < DECK_IDS.length; j++) out.push([DECK_IDS[i]!, DECK_IDS[j]!]);
  }
  return out;
})();

const list = (id: string): OracleId[] => deckList(DECKS[id]!);

const PLANS: Plan[] = (() => {
  const out: Plan[] = [];

  // The six decks against each other, kept straight so the ordinary game is the
  // baseline everything else is measured against.
  const straightSeeds = [1, 2, 3, 5, 8, 13];
  PAIRINGS.forEach(([a, b], index) => {
    for (const seed of straightSeeds) {
      // Alternate the seat: being on the play is a real advantage, and a soak that
      // only ever ran one way round would only ever soak half the openings.
      const swap = (index + seed) % 2 === 1;
      out.push({
        family: 'decks',
        label: `${swap ? b : a} vs ${swap ? a : b}`,
        seed,
        deckA: list(swap ? b : a),
        deckB: list(swap ? a : b),
        mulligans: [0, 0],
        forced: NOTHING_FORCED,
      });
    }
  });

  // The same decks, but every mulligan count either player can take, including
  // both players going to the floor at three.
  PAIRINGS.forEach(([a, b], index) => {
    const mulligans = MULLIGAN_PLANS[index % MULLIGAN_PLANS.length]!;
    for (const seed of [17, 21, 34]) {
      out.push({
        family: 'mulligan',
        label: `${a} vs ${b} (mull ${mulligans[0]}/${mulligans[1]})`,
        seed,
        deckA: list(a),
        deckB: list(b),
        mulligans,
        forced: NOTHING_FORCED,
      });
    }
  });

  // The scry deck against every real deck, with the spell and the Island that
  // casts it both in the opening hand, so the decision is reached on turn one or
  // two of every one of these games. The seat alternates: a scry taken on your
  // own turn and a scry taken while the opponent is the active player are two
  // different priority questions, and only one of them is the easy one.
  DECK_IDS.forEach((id, index) => {
    for (const seed of [41, 55, 89]) {
      const spell: OracleId = (index + seed) % 2 === 0 ? 'opt' : 'preordain';
      const onPlay = (index + seed) % 3 === 0;
      out.push({
        family: 'scry',
        label: `scry (${spell}, ${onPlay ? 'play' : 'draw'}) vs ${id}`,
        seed,
        deckA: onPlay ? SCRY_DECK : list(id),
        deckB: onPlay ? list(id) : SCRY_DECK,
        mulligans: [0, 0],
        forced: onPlay ? [[spell, 'island'], []] : [[], [spell, 'island']],
      });
    }
  });

  // Both sides scrying, so the decision comes up on both sides of the priority
  // question rather than only for the active player.
  for (const seed of [144, 233, 377, 610, 987, 1597]) {
    out.push({
      family: 'scry-mirror',
      label: 'scry vs scry',
      seed,
      deckA: SCRY_DECK,
      deckB: SCRY_DECK,
      mulligans: [0, 0],
      forced: [
        ['opt', 'island'],
        ['preordain', 'island'],
      ],
    });
  }

  // The two decisions that happen before turn one, in the same game: mulligan
  // down to four and then scry off the hand you kept.
  MULLIGAN_PLANS.forEach((mulligans, index) => {
    out.push({
      family: 'scry+mulligan',
      label: `scry mirror (mull ${mulligans[0]}/${mulligans[1]})`,
      seed: 2584 + index,
      deckA: SCRY_DECK,
      deckB: SCRY_DECK,
      mulligans,
      forced: NOTHING_FORCED,
    });
  });

  return out;
})();

// ---------------------------------------------------------------------------
// Setting a game up
// ---------------------------------------------------------------------------

/**
 * Swap a card of this oracle id out of the library and into the opening hand.
 *
 * Deliberately a swap rather than an extra draw: the hand stays seven cards, so
 * the London keep it is about to make is the same keep every other game makes,
 * and the deck stays sixty cards. A hand that already holds one is left alone.
 */
function forceIntoHand(state: GameState, player: PlayerId, oracleId: OracleId): GameState {
  const next = cloneState(state);
  const side = next.players[player];
  const oracleOf = (id: CardId): OracleId => next.cards[id]!.oracleId;

  if (side.hand.some((id) => oracleOf(id) === oracleId)) return next;

  const fromLibrary = side.library.findIndex((id) => oracleOf(id) === oracleId);
  if (fromLibrary < 0) throw new Error(`forceIntoHand: no "${oracleId}" left in the library`);
  const fromHand = side.hand.findIndex((id) => oracleOf(id) !== oracleId);
  if (fromHand < 0) throw new Error('forceIntoHand: nothing in hand to swap out');

  const arriving = side.library[fromLibrary]!;
  const leaving = side.hand[fromHand]!;
  side.library[fromLibrary] = leaving;
  side.hand[fromHand] = arriving;
  next.cards[arriving]!.zone = 'hand';
  next.cards[leaving]!.zone = 'library';
  return next;
}

/** A dealt game wound back to the pre-game, with whatever the plan forced in hand. */
function setUp(plan: Plan): GameState {
  let state = createGame(CARDS, plan.deckA, plan.deckB, plan.seed);
  for (const player of [0, 1] as const) {
    for (const oracleId of plan.forced[player]) state = forceIntoHand(state, player, oracleId);
  }
  return beginMulligans(state).state;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)]!;
}

/**
 * Every legal way to put two creatures in front of one attacker.
 *
 * The gang block is the only thing that produces a damage assignment order to
 * decide, and it is not in the candidate list for any attacker without menace —
 * see the header. Each pair is checked with `isLegal`, which for blocks consults
 * `validateBlocks` directly, so flying, tapped creatures, walls that cannot
 * block and everything else are all still enforced. The list is short: boards in
 * this soak run to a handful of creatures a side.
 */
function gangBlocks(state: GameState): Action[] {
  if (state.phase !== 'declareBlockers') return [];
  const defender = opponentOf(state.active);
  if (state.priority !== defender) return [];

  const attackers = state.players[state.active].battlefield.filter(
    (id) => state.cards[id]?.attacking === true,
  );
  const blockers = state.players[defender].battlefield.filter(
    (id) => isCreature(state, id) && state.cards[id]!.tapped === false,
  );

  const out: Action[] = [];
  for (const attacker of attackers) {
    for (let i = 0; i < blockers.length; i++) {
      for (let j = i + 1; j < blockers.length; j++) {
        const action: Action = {
          kind: 'declareBlockers',
          blocks: [
            { blocker: blockers[i]!, attacker },
            { blocker: blockers[j]!, attacker },
          ],
        };
        if (isLegal(state, action)) out.push(action);
      }
    }
  }
  return out;
}

/**
 * Take a legal action, preferring one that does something.
 *
 * The mulligan is the one place the choice is scripted rather than sampled: the
 * plan says how many to take, so that a game meant to test a three-card bottom
 * really takes three. Everywhere else this is the dumbest possible player —
 * anything but `pass`, chosen at random, and `pass` only when the generator
 * offers nothing else. The gang blocks are folded in alongside the offered
 * moves, having already been through `isLegal`.
 */
function choose(state: GameState, legal: readonly Action[], plan: Plan, rng: Rng): Action {
  if (inMulligan(state)) {
    const player = state.priority;
    const wanted = Math.min(plan.mulligans[player], MAX_MULLIGANS);
    if (state.players[player].mulligansTaken < wanted) {
      const again = legal.find((action) => action.kind === 'mulligan');
      if (again) return again;
    }
    const keeps = legal.filter((action) => action.kind === 'keepHand');
    return keeps.length > 0 ? pick(keeps, rng) : pick(legal, rng);
  }

  const doing = [...legal.filter((action) => action.kind !== 'pass'), ...gangBlocks(state)];
  return doing.length > 0 ? pick(doing, rng) : pick(legal, rng);
}

// ---------------------------------------------------------------------------
// Playing a game
// ---------------------------------------------------------------------------

/** How many times each kind of action was actually played. */
type Tally = Record<string, number>;

interface GameRecord {
  plan: Plan;
  winner: PlayerId | null;
  turns: number;
  actions: number;
  /** Set when `reduce` refused a move `legalActions` had just offered. */
  error: string | null;
  /** Set when `legalActions` came back empty with no winner: the hang. */
  hang: string | null;
  /** Set when a card turned up in two zones at once, or in none. */
  incoherent: string | null;
  /** Hand sizes the moment turn one began, i.e. after both London keeps. */
  openingHands: [number, number] | null;
  mulligansTaken: [number, number];
  /** How many distinct states set `pendingScry` over the game. */
  scries: number;
  played: Tally;
  /** The widest `legalActions` this game ever produced. */
  widest: number;
}

/** The zone arrays a player keeps, in the order they are checked. */
const ZONE_ARRAYS = ['library', 'hand', 'battlefield', 'graveyard', 'exile'] as const;

/**
 * Is every card in exactly the one zone array its instance says it is in?
 *
 * Worth a check on every single state because this is how the four decisions
 * actually break the game. The scry bug this soak found did not throw where it
 * happened: `pendingScry` put a card back into a library that had since drawn
 * it, and nothing complained until fifteen actions later, when the same creature
 * appeared twice in a battlefield and `legalActions` offered an attack listing
 * it twice — which `validateAttack` then refused. A duplicate is a card in two
 * places at once, and the place to catch it is the moment it appears.
 *
 * Two things are deliberately not violations. A card on the stack lives in no
 * player's array — `rules.ts` owns the `StackObject` — and the cards of a
 * pending scry are off the top of the library and parked on `state.pendingScry`
 * until their controller says where they go, which is the contract `scry` and
 * `scryDecision` keep between them.
 */
function incoherent(state: GameState): string | null {
  const parked = new Set<CardId>(state.pendingScry?.cards ?? []);

  const seen = new Map<CardId, string>();
  for (const player of [0, 1] as const) {
    for (const zone of ZONE_ARRAYS) {
      for (const id of state.players[player][zone]) {
        const where = `player ${player} ${zone}`;
        const already = seen.get(id);
        if (already) return `"${id}" is in both ${already} and ${where}`;
        seen.set(id, where);
        const instance = state.cards[id];
        if (!instance) return `"${id}" is in ${where} but has no instance`;
        if (instance.zone !== zone) return `"${id}" is in ${where} but its instance says ${instance.zone}`;
      }
    }
  }

  for (const [id, instance] of Object.entries(state.cards)) {
    if (instance.zone === 'stack') {
      if (seen.has(id)) return `"${id}" is on the stack and in ${seen.get(id)}`;
      continue;
    }
    if (parked.has(id)) {
      if (seen.has(id)) return `"${id}" is parked on a pending scry and still in ${seen.get(id)}`;
      continue;
    }
    if (!seen.has(id)) return `"${id}" says it is in the ${instance.zone} but is in no zone array`;
  }
  return null;
}

const describeState = (state: GameState): string =>
  `turn ${state.turn} ${state.phase}, active ${state.active}, priority ${state.priority}, ` +
  `stack ${state.stack.length}, pendingScry ${JSON.stringify(state.pendingScry)}, ` +
  `life ${state.players[0].life}/${state.players[1].life}`;

/**
 * Play one game from the pre-game to a winner.
 *
 * The loop is the whole test: ask `legalActions`, check it is not empty, take
 * one of them, `reduce`. Nothing here constructs an `Action` and nothing reaches
 * into the state to move a card — every change to the game goes through the
 * reducer, exactly as it does under the UI.
 *
 * A throw or a hang is recorded and the game stops, rather than being thrown on:
 * one broken plan should report itself, not hide the other hundred behind a
 * stack trace.
 */
function playGame(plan: Plan): GameRecord {
  let state = setUp(plan);
  const rng = makeRng(plan.seed * 2654435761 + 1);

  const played: Tally = {};
  let actions = 0;
  let scries = 0;
  let widest = 0;
  let openingHands: [number, number] | null = null;
  let last: Action | null = null;

  const record: GameRecord = {
    plan,
    winner: null,
    turns: state.turn,
    actions: 0,
    error: null,
    hang: null,
    incoherent: null,
    openingHands: null,
    mulligansTaken: [0, 0],
    scries: 0,
    played,
    widest: 0,
  };

  const finish = (): GameRecord => ({
    ...record,
    winner: state.winner,
    turns: state.turn,
    actions,
    openingHands,
    mulligansTaken: [state.players[0].mulligansTaken, state.players[1].mulligansTaken],
    scries,
    played,
    widest,
  });

  try {
    while (state.winner === null && state.turn <= TURN_LIMIT && actions < ACTION_LIMIT) {
      const legal = legalActions(state);
      widest = Math.max(widest, legal.length);

      // The hang. `legalActions` is the only definition of what may happen next,
      // so an empty list with the game still running is a game waiting on a
      // decision that nobody — not the UI, not the bot, not this loop — can make.
      if (legal.length === 0) {
        record.hang = `no legal action at ${describeState(state)}`;
        return finish();
      }

      const wasInMulligan = inMulligan(state);
      const scryBefore = state.pendingScry;

      last = choose(state, legal, plan, rng);
      played[last.kind] = (played[last.kind] ?? 0) + 1;
      state = reduce(state, last).state;
      actions += 1;

      // A scry counts when one is set up, not when it is answered, so a scry that
      // was never offered a decision would still be seen here.
      if (state.pendingScry !== null && state.pendingScry !== scryBefore) scries += 1;
      if (wasInMulligan && !inMulligan(state)) {
        openingHands = [state.players[0].hand.length, state.players[1].hand.length];
      }

      const broken = incoherent(state);
      if (broken) {
        record.incoherent = `after ${JSON.stringify(last)}: ${broken}, at ${describeState(state)}`;
        return finish();
      }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    record.error = `${describeState(state)}, playing ${JSON.stringify(last)}: ${why}`;
  }

  return finish();
}

/**
 * The whole soak, played once at module load.
 *
 * Module level rather than a `beforeAll` because every test below reads the same
 * games and none of them should pay to replay them — the same shape as
 * `playtest.test.ts`. Everything is seeded, so this is the same games every run.
 */
const GAMES: GameRecord[] = PLANS.map(playGame);

const familyOf = (family: string): GameRecord[] => GAMES.filter((g) => g.plan.family === family);

const describeGame = (game: GameRecord): string =>
  `${game.plan.family}: ${game.plan.label} seed ${game.plan.seed}`;

const totalPlayed = (kind: string): number =>
  GAMES.reduce((sum, game) => sum + (game.played[kind] ?? 0), 0);

// ---------------------------------------------------------------------------
// The soak itself
// ---------------------------------------------------------------------------

describe('the soak', () => {
  it('plays a lot of complete games', () => {
    expect(GAMES.length).toBeGreaterThanOrEqual(100);
    expect(new Set(PLANS.map((plan) => plan.seed)).size).toBeGreaterThanOrEqual(10);
  });

  it('covers every family of plan', () => {
    for (const family of ['decks', 'mulligan', 'scry', 'scry-mirror', 'scry+mulligan']) {
      expect(familyOf(family).length, family).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The hang
// ---------------------------------------------------------------------------

describe('legalActions is never empty while the game is running', () => {
  it('always offers the player with priority something to do', () => {
    // The property this file exists for. An empty list with no winner is not a
    // wrong answer, it is a game that has stopped: the engine is waiting on a
    // decision and offering no way to make it.
    const hung = GAMES.filter((game) => game.hang !== null).map(
      (game) => `${describeGame(game)}: ${game.hang}`,
    );
    expect(hung).toEqual([]);
  });

  it('never lets a card be in two zones at once', () => {
    // The near miss. A duplicate does not hang the game where it is created — it
    // hangs it later, when the generator offers a move built out of the
    // duplicate and the reducer refuses it. See {@link incoherent}.
    const broken = GAMES.filter((game) => game.incoherent !== null).map(
      (game) => `${describeGame(game)}: ${game.incoherent}`,
    );
    expect(broken).toEqual([]);
  });

  it('offers at least one action at every state of every game', () => {
    // The same property counted the other way round: every game saw a widest
    // list of at least one, and every action played came out of such a list.
    for (const game of GAMES) expect(game.widest, describeGame(game)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

describe('every game terminates', () => {
  it('produces a winner in every game', () => {
    const undecided = GAMES.filter((game) => game.winner === null).map(
      (game) => `${describeGame(game)} ended with no winner on turn ${game.turns}`,
    );
    expect(undecided).toEqual([]);
  });

  it(`finishes inside ${TURN_LIMIT} turns`, () => {
    const overlong = GAMES.filter((game) => game.turns > TURN_LIMIT).map(
      (game) => `${describeGame(game)} reached turn ${game.turns}`,
    );
    expect(overlong).toEqual([]);
  });

  it('never hits the action cap', () => {
    // Separate from the turn limit: a game that hands priority back and forth
    // without advancing its turn counter would pass the turn check forever.
    const stalled = GAMES.filter((game) => game.actions >= ACTION_LIMIT).map(
      (game) => `${describeGame(game)} played ${game.actions} actions`,
    );
    expect(stalled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

describe('reduce never throws', () => {
  it('accepts every action legalActions offered', () => {
    // Every action played here came straight out of `legalActions`. A throw says
    // the generator offered a move the reducer then refused, which is the one
    // assumption the whole design rests on.
    const thrown = GAMES.filter((game) => game.error !== null).map(
      (game) => `${describeGame(game)}: ${game.error}`,
    );
    expect(thrown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The four gaps were actually reached
// ---------------------------------------------------------------------------

describe('the four closed gaps are exercised', () => {
  it('takes mulligans and keeps hands', () => {
    expect(totalPlayed('mulligan')).toBeGreaterThan(0);
    // Two keeps per game: one per player, every game, no exceptions.
    expect(totalPlayed('keepHand')).toBe(2 * GAMES.length);
  });

  it('answers a scry', () => {
    expect(totalPlayed('scryDecision')).toBeGreaterThan(0);
  });

  it('taps lands by hand', () => {
    expect(totalPlayed('tapLand')).toBeGreaterThan(0);
  });

  it('orders blockers', () => {
    expect(totalPlayed('orderBlockers')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The mulligan, over a whole game
// ---------------------------------------------------------------------------

describe('the mulligan holds up across a whole game', () => {
  it('takes exactly the mulligans the plan called for', () => {
    for (const game of GAMES) {
      for (const player of [0, 1] as const) {
        const wanted = Math.min(game.plan.mulligans[player], MAX_MULLIGANS);
        expect(game.mulligansTaken[player], `${describeGame(game)} player ${player}`).toBe(wanted);
      }
    }
  });

  it('starts turn one on a hand one card shorter per mulligan taken', () => {
    for (const game of GAMES) {
      expect(game.openingHands, describeGame(game)).not.toBeNull();
      for (const player of [0, 1] as const) {
        const taken = game.mulligansTaken[player];
        expect(game.openingHands![player], `${describeGame(game)} player ${player}`).toBe(
          STARTING_HAND - taken,
        );
      }
    }
  });

  it('reaches the floor of three mulligans in at least one game', () => {
    const floored = GAMES.filter((game) => game.mulligansTaken.includes(MAX_MULLIGANS));
    expect(floored.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scry, over a whole game
// ---------------------------------------------------------------------------

describe('scry holds up across a whole game', () => {
  it('sets up a scry in every game that was dealt a scry spell', () => {
    const forced = GAMES.filter((game) => game.plan.family === 'scry');
    expect(forced.length).toBeGreaterThan(0);
    const silent = forced.filter((game) => game.scries === 0).map(describeGame);
    expect(silent).toEqual([]);
  });

  it('scries on both sides of the table', () => {
    const mirror = familyOf('scry-mirror');
    expect(mirror.every((game) => game.scries > 0)).toBe(true);
  });

  it('answers every scry it sets up', () => {
    // A scry that was set up and never answered is the hang this file is about:
    // the cards are off the top of the library and the game cannot move on.
    // Every game reached a winner, so every pending scry was decided.
    const setUps = GAMES.reduce((sum, game) => sum + game.scries, 0);
    expect(totalPlayed('scryDecision')).toBe(setUps);
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const mean = (numbers: number[]): number =>
  numbers.length === 0 ? 0 : numbers.reduce((a, b) => a + b, 0) / numbers.length;

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

afterAll(() => {
  const lines: string[] = [];
  const families = [...new Set(PLANS.map((plan) => plan.family))];

  lines.push('');
  lines.push(`gaps soak: ${GAMES.length} complete games, random legal play, ${PLANS.length} plans`);
  lines.push('');
  lines.push(
    `  ${pad('family', 16)}${pad('games', 8)}${pad('avg turns', 11)}${pad('turn range', 13)}` +
      `${pad('avg actions', 13)}scries`,
  );
  for (const family of families) {
    const games = familyOf(family);
    const turns = games.map((game) => game.turns);
    lines.push(
      `  ${pad(family, 16)}${pad(String(games.length), 8)}` +
        `${pad(mean(turns).toFixed(1), 11)}` +
        `${pad(`${Math.min(...turns)}-${Math.max(...turns)}`, 13)}` +
        `${pad(mean(games.map((game) => game.actions)).toFixed(0), 13)}` +
        `${games.reduce((sum, game) => sum + game.scries, 0)}`,
    );
  }

  const kinds = [...new Set(GAMES.flatMap((game) => Object.keys(game.played)))].sort();
  lines.push('');
  lines.push(`  actions played, by kind (${GAMES.reduce((n, g) => n + g.actions, 0)} total)`);
  for (const kind of kinds) lines.push(`  ${pad(kind, 20)}${totalPlayed(kind)}`);

  lines.push('');
  lines.push(
    `  widest legalActions seen: ${Math.max(...GAMES.map((game) => game.widest))}; ` +
      `longest game ${Math.max(...GAMES.map((game) => game.turns))} turns, ` +
      `${Math.max(...GAMES.map((game) => game.actions))} actions`,
  );
  lines.push('');

  console.log(lines.join('\n'));
});
