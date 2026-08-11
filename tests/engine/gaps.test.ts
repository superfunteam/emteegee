/**
 * The four decisions the engine used to declare and then refuse.
 *
 * `types.ts` has always had `mulligan`, `keepHand`, `scryDecision`, `tapLand`
 * and `orderBlockers` in the `Action` union, and `reduce` used to throw a named
 * error for every one of them. Each is a moment a player actually reaches: the
 * opening hand, the card an Opt just looked at, the mana row under a long
 * press, and two creatures standing in front of one attacker.
 *
 * These tests are written against behaviour, not shape. A mulligan has to
 * produce a *different* seven; a scry has to put the card where it said it
 * would; floated mana has to be the mana the next spell spends; and the order
 * an attacker chooses has to be the order that decides which blocker dies.
 */

import { describe, expect, it } from 'vitest';
import type { Action, CardId, GameState, StackObject } from '../../src/engine/types';
import { MAX_MULLIGANS } from '../../src/engine/types';
import {
  MULLIGAN_TURN,
  inMulligan,
  isLegal,
  legalActions,
  validateBlockerOrder,
  validateKeepHand,
  validateScry,
} from '../../src/engine/actions';
import { beginMulligans, reduce } from '../../src/engine/rules';
import { cloneState, createGame, newInstance } from '../../src/engine/state';
import { declareAttackers, declareBlockers } from '../../src/engine/combat';
import {
  TEST_DECK,
  TEST_DEFS,
  battlefield,
  gameWith,
  giveLands,
  putCreature,
} from '../fixtures';

const PASS: Action = { kind: 'pass' };

/** A dealt game, before anyone has decided anything. */
function dealt(seed = 7): GameState {
  return beginMulligans(createGame(TEST_DEFS, TEST_DECK, TEST_DECK, seed)).state;
}

function kinds(state: GameState): Set<string> {
  return new Set(legalActions(state).map((action) => action.kind));
}

// ---------------------------------------------------------------------------
// The mulligan
// ---------------------------------------------------------------------------

describe('the mulligan', () => {
  it('opens the game on a decision and nothing else', () => {
    const state = dealt();

    expect(inMulligan(state)).toBe(true);
    expect(state.turn).toBe(MULLIGAN_TURN);
    expect(state.priority).toBe(0);
    expect(kinds(state)).toEqual(new Set(['mulligan', 'keepHand']));
    // There is no advancing past an opening hand nobody has decided on.
    expect(isLegal(state, PASS)).toBe(false);
  });

  it('shuffles the hand back and deals a different seven', () => {
    const state = dealt();
    const before = state.players[0].hand;

    const after = reduce(state, { kind: 'mulligan' }).state;
    const hand = after.players[0].hand;

    expect(hand).toHaveLength(7);
    expect(hand).not.toEqual(before);
    expect(after.players[0].mulligansTaken).toBe(1);
    expect(after.players[0].library).toHaveLength(53);
    for (const id of hand) expect(after.cards[id]!.zone).toBe('hand');
    // Every card of the old hand is back in the library somewhere.
    for (const id of before) {
      expect(after.players[0].library.includes(id) || hand.includes(id)).toBe(true);
    }
    // Still the same player's decision.
    expect(after.priority).toBe(0);
  });

  it('deals a different seven each time rather than reshuffling to the same order', () => {
    const first = reduce(dealt(), { kind: 'mulligan' }).state;
    const second = reduce(first, { kind: 'mulligan' }).state;

    expect(second.players[0].hand).not.toEqual(first.players[0].hand);
    expect(second.players[0].mulligansTaken).toBe(2);
  });

  it('is reproducible from the seed', () => {
    const a = reduce(dealt(11), { kind: 'mulligan' }).state;
    const b = reduce(dealt(11), { kind: 'mulligan' }).state;
    expect(a.players[0].hand).toEqual(b.players[0].hand);
  });

  it('offers a third mulligan and then no more', () => {
    let state = dealt();
    for (let taken = 0; taken < MAX_MULLIGANS; taken++) {
      expect(kinds(state).has('mulligan')).toBe(true);
      state = reduce(state, { kind: 'mulligan' }).state;
    }

    expect(state.players[0].mulligansTaken).toBe(MAX_MULLIGANS);
    expect(kinds(state)).toEqual(new Set(['keepHand']));
    expect(isLegal(state, { kind: 'mulligan' })).toBe(false);
  });

  it('bottoms exactly one card per mulligan taken, at the bottom of the library', () => {
    let state = dealt();
    state = reduce(state, { kind: 'mulligan' }).state;
    state = reduce(state, { kind: 'mulligan' }).state;

    const hand = [...state.players[0].hand];
    const librarySize = state.players[0].library.length;
    const toBottom = [hand[3]!, hand[0]!];

    const after = reduce(state, { kind: 'keepHand', toBottom }).state;

    expect(after.players[0].hand).toHaveLength(5);
    expect(after.players[0].library).toHaveLength(librarySize + 2);
    // In the order the player listed them, and underneath everything else.
    expect(after.players[0].library.slice(-2)).toEqual(toBottom);
    for (const id of toBottom) expect(after.cards[id]!.zone).toBe('library');
  });

  it('refuses a keep that puts back the wrong number of cards', () => {
    const state = reduce(dealt(), { kind: 'mulligan' }).state;
    const hand = state.players[0].hand;

    expect(validateKeepHand(state, [])).not.toBeNull();
    expect(validateKeepHand(state, [hand[0]!, hand[1]!])).not.toBeNull();
    expect(validateKeepHand(state, [hand[0]!])).toBeNull();

    expect(isLegal(state, { kind: 'keepHand', toBottom: [] })).toBe(false);
    expect(isLegal(state, { kind: 'keepHand', toBottom: [hand[2]!] })).toBe(true);
  });

  it('refuses a keep that puts back a card that is not in hand', () => {
    const state = reduce(dealt(), { kind: 'mulligan' }).state;
    const theirs = state.players[1].hand[0]!;

    expect(validateKeepHand(state, [theirs])).not.toBeNull();
    expect(validateKeepHand(state, ['nonexistent'])).not.toBeNull();
  });

  it('offers a keep for every card in hand, so any one of them can go back', () => {
    const state = reduce(dealt(), { kind: 'mulligan' }).state;
    const offered = new Set(
      legalActions(state)
        .filter((action) => action.kind === 'keepHand')
        .map((action) => (action.kind === 'keepHand' ? action.toBottom.join('|') : '')),
    );

    for (const card of state.players[0].hand) expect(offered.has(card)).toBe(true);
  });

  it('asks the human first and the Magician second', () => {
    let state = dealt();
    state = reduce(state, { kind: 'keepHand', toBottom: [] }).state;

    expect(state.priority).toBe(1);
    expect(inMulligan(state)).toBe(true);
    expect(kinds(state)).toEqual(new Set(['mulligan', 'keepHand']));

    // The opponent's own count, kept separately from the human's.
    state = reduce(state, { kind: 'mulligan' }).state;
    expect(state.players[1].mulligansTaken).toBe(1);
    expect(state.players[0].mulligansTaken).toBe(0);
    expect(state.priority).toBe(1);
  });

  it('starts turn one once both players have kept', () => {
    const kept = reduce(dealt(), { kind: 'keepHand', toBottom: [] }).state;
    const result = reduce(kept, { kind: 'keepHand', toBottom: [] });
    const state = result.state;

    expect(inMulligan(state)).toBe(false);
    expect(state.turn).toBe(1);
    expect(state.phase).toBe('main1');
    expect(state.active).toBe(0);
    expect(state.priority).toBe(0);
    expect(result.events).toContainEqual({ type: 'PHASE', phase: 'main1', active: 0, turn: 1 });

    // And the game is an ordinary game again.
    expect(kinds(state).has('pass')).toBe(true);
    expect(kinds(state).has('mulligan')).toBe(false);
    expect(state.players[0].hand).toHaveLength(7);
  });

  it('leaves the state it was handed untouched', () => {
    const state = dealt();
    const before = JSON.stringify(state);
    reduce(state, { kind: 'mulligan' });
    reduce(state, { kind: 'keepHand', toBottom: [] });
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Scry
// ---------------------------------------------------------------------------

/** A game whose player 0 is looking at the top two cards of a four-card library. */
function scrying(): GameState {
  const state = cloneState(gameWith({ library: [['a', 'b', 'c', 'd'], []] }));
  state.pendingScry = { player: 0, cards: ['a', 'b'] };
  return state;
}

describe('scry', () => {
  it('is the only thing that may happen while it is pending', () => {
    const state = scrying();

    expect(kinds(state)).toEqual(new Set(['scryDecision']));
    expect(isLegal(state, PASS)).toBe(false);
    expect(legalActions(state).length).toBeGreaterThan(1);
  });

  it('offers nothing at all to the player who does not owe the decision', () => {
    const theirs = cloneState(scrying());
    theirs.priority = 1;
    expect(legalActions(theirs)).toEqual([]);
  });

  it('puts the chosen card on the bottom and leaves the rest on top', () => {
    const after = reduce(scrying(), { kind: 'scryDecision', toBottom: ['a'] }).state;

    expect(after.players[0].library).toEqual(['b', 'c', 'd', 'a']);
    expect(after.pendingScry).toBeNull();
  });

  it('keeps both cards on top, in their original order, when none go to the bottom', () => {
    const after = reduce(scrying(), { kind: 'scryDecision', toBottom: [] }).state;
    expect(after.players[0].library).toEqual(['a', 'b', 'c', 'd']);
  });

  it('bottoms several cards in the order they were chosen', () => {
    const after = reduce(scrying(), { kind: 'scryDecision', toBottom: ['b', 'a'] }).state;
    expect(after.players[0].library).toEqual(['c', 'd', 'b', 'a']);
  });

  it('refuses a card the player never looked at', () => {
    const state = scrying();
    expect(validateScry(state, ['c'])).not.toBeNull();
    expect(validateScry(state, ['a', 'a'])).not.toBeNull();
    expect(isLegal(state, { kind: 'scryDecision', toBottom: ['c'] })).toBe(false);
  });

  it('refuses a decision when no scry is waiting', () => {
    expect(validateScry(gameWith({}), [])).not.toBeNull();
  });

  it('hands the game back once the decision is made', () => {
    // The forest in hand is a real choice, so the settled game stops with the
    // player back in charge rather than auto-advancing past them (spec §9.4).
    const state = newInstance(scrying(), 'forest', 0, 'hand').state;
    const after = reduce(state, { kind: 'scryDecision', toBottom: ['a'] }).state;
    expect(after.pendingScry).toBeNull();
    expect(after.priority).toBe(0);
    expect(kinds(after).has('pass')).toBe(true);
  });

  it('stops the game the moment a spell sets one up', () => {
    const spell: StackObject = {
      id: 'spell#0',
      source: 'opt',
      controller: 0,
      effects: [{ kind: 'scry', count: 2 }],
      targets: null,
      isTriggered: false,
    };
    const state = gameWith({ library: [['a', 'b', 'c'], []], stack: [spell] });

    const result = reduce(state, PASS);

    expect(result.state.pendingScry).toEqual({ player: 0, cards: ['a', 'b'] });
    expect(result.state.priority).toBe(0);
    expect(kinds(result.state)).toEqual(new Set(['scryDecision']));

    const decided = reduce(result.state, { kind: 'scryDecision', toBottom: ['b'] }).state;
    expect(decided.players[0].library).toEqual(['a', 'c', 'b']);
    expect(decided.pendingScry).toBeNull();
  });

  it('leaves the state it was handed untouched', () => {
    const state = scrying();
    const before = JSON.stringify(state);
    reduce(state, { kind: 'scryDecision', toBottom: ['a'] });
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tapping lands by hand
// ---------------------------------------------------------------------------

/** Player 0, in their main phase, with `n` untapped Forests. */
function withForests(n: number): GameState {
  return giveLands(gameWith({}), 0, 'G', n);
}

function forestsOf(state: GameState): CardId[] {
  return state.players[0].battlefield.filter((id) => state.cards[id]!.oracleId === 'forest');
}

describe('tapping a land by hand', () => {
  it('offers every untapped land the player controls, and no tapped one', () => {
    const state = withForests(3);
    expect(legalActions(state).filter((action) => action.kind === 'tapLand')).toHaveLength(3);

    const spent = cloneState(state);
    spent.cards[forestsOf(spent)[0]!]!.tapped = true;
    expect(legalActions(spent).filter((action) => action.kind === 'tapLand')).toHaveLength(2);
  });

  it('never offers a creature, which is not a land', () => {
    const { state } = putCreature(withForests(1), 0, 'grizzly-bears');
    const taps = legalActions(state).filter((action) => action.kind === 'tapLand');
    expect(taps).toHaveLength(1);
    expect(taps[0]).toEqual({ kind: 'tapLand', card: forestsOf(state)[0] });
  });

  it('taps the land and floats its mana', () => {
    // The trick in hand (castable at the bear) is what makes the float worth
    // stopping for; with nothing to spend it on, tapping is a no-op and the
    // settled game would advance past the wasted mana (spec §9.4).
    let state = withForests(2);
    const bear = putCreature(state, 0, 'grizzly-bears');
    state = newInstance(bear.state, 'giant-growth', 0, 'hand').state;
    const land = forestsOf(state)[0]!;

    const result = reduce(state, { kind: 'tapLand', card: land });

    expect(result.state.cards[land]!.tapped).toBe(true);
    expect(result.state.players[0].manaPool).toEqual({ G: 1 });
    expect(result.events).toContainEqual({ type: 'TAP', card: land });
    // The whole point is to spend it, so the player keeps priority.
    expect(result.state.priority).toBe(0);
  });

  it('spends the floated mana rather than tapping a second land', () => {
    let state = withForests(2);
    const bear = putCreature(state, 0, 'grizzly-bears');
    state = bear.state;
    const trick = newInstance(state, 'giant-growth', 0, 'hand');
    state = trick.state;

    const lands = forestsOf(state);
    state = reduce(state, { kind: 'tapLand', card: lands[0]! }).state;
    expect(state.players[0].manaPool).toEqual({ G: 1 });

    const cast = reduce(state, { kind: 'castSpell', card: trick.id, targets: [bear.id] }).state;

    expect(cast.players[0].manaPool).toEqual({});
    expect(cast.cards[lands[1]!]!.tapped).toBe(false);
  });

  it('does not stop the game: an untapped land is not a decision', () => {
    const state = giveLands(gameWith({ library: [['a'], ['b']] }), 0, 'G', 3);
    const result = reduce(state, PASS);

    // The same pass that runs a whole empty turn with no lands out.
    expect(result.state.active).toBe(1);
  });

  it('leaves the state it was handed untouched', () => {
    const state = withForests(2);
    const before = JSON.stringify(state);
    reduce(state, { kind: 'tapLand', card: forestsOf(state)[0]! });
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Ordering blockers
// ---------------------------------------------------------------------------

/**
 * A 2/5 attacker held up by two 1/2 blockers, stopped in the step before
 * damage.
 *
 * The attacker has exactly two damage to give, which is lethal for exactly one
 * of them: whichever one it is told to hit first.
 */
function gangBlocked(): GameState {
  const board = battlefield({
    you: [{ power: 2, toughness: 5 }],
    them: [
      { power: 1, toughness: 2 },
      { power: 1, toughness: 2 },
    ],
  });
  const attacked = reduce(board, { kind: 'declareAttackers', attackers: ['you0'] }).state;
  return reduce(attacked, {
    kind: 'declareBlockers',
    blocks: [
      { blocker: 'them0', attacker: 'you0' },
      { blocker: 'them1', attacker: 'you0' },
    ],
  }).state;
}

describe('ordering blockers', () => {
  it('stops the attacking player before damage when an attacker is gang-blocked', () => {
    const state = gangBlocked();

    expect(state.phase).toBe('firstStrikeDamage');
    expect(state.priority).toBe(0);

    const orders = legalActions(state).filter((action) => action.kind === 'orderBlockers');
    expect(orders).toHaveLength(2);
    expect(orders.every((action) => action.kind === 'orderBlockers' && action.attacker === 'you0')).toBe(true);
    // Both creatures are still alive: nothing has been dealt yet.
    expect(state.cards['them0']!.zone).toBe('battlefield');
    expect(state.cards['them1']!.zone).toBe('battlefield');
  });

  it('kills the blocker the attacker put first', () => {
    const after = reduce(gangBlocked(), {
      kind: 'orderBlockers',
      attacker: 'you0',
      order: ['them1', 'them0'],
    }).state;

    expect(after.cards['them1']!.zone).toBe('graveyard');
    expect(after.cards['them0']!.zone).toBe('battlefield');
  });

  it('kills the other one when the order is the other way round', () => {
    const after = reduce(gangBlocked(), {
      kind: 'orderBlockers',
      attacker: 'you0',
      order: ['them0', 'them1'],
    }).state;

    expect(after.cards['them0']!.zone).toBe('graveyard');
    expect(after.cards['them1']!.zone).toBe('battlefield');
  });

  it('passes the decision to the defender, so an attack is ordered once', () => {
    let state = gangBlocked();
    // A trick in the defender's hand keeps their window open, so the state after
    // ordering is one this test can actually look at.
    state = giveLands(state, 1, 'G', 1);
    state = newInstance(state, 'giant-growth', 1, 'hand').state;

    const after = reduce(state, {
      kind: 'orderBlockers',
      attacker: 'you0',
      order: ['them1', 'them0'],
    }).state;

    expect(after.phase).toBe('firstStrikeDamage');
    expect(after.priority).toBe(1);
    expect(after.cards['you0']!.blockedBy).toEqual(['them1', 'them0']);
    expect(legalActions(after).some((action) => action.kind === 'orderBlockers')).toBe(false);
    expect(isLegal(after, { kind: 'orderBlockers', attacker: 'you0', order: ['them0', 'them1'] })).toBe(false);
  });

  it('offers nothing, and gains no stop, when a single blocker blocks', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 5 }],
      them: [
        { power: 1, toughness: 2 },
        { power: 1, toughness: 2 },
      ],
    });
    const attacked = reduce(board, { kind: 'declareAttackers', attackers: ['you0'] }).state;
    const blocked = reduce(attacked, {
      kind: 'declareBlockers',
      blocks: [{ blocker: 'them0', attacker: 'you0' }],
    }).state;

    // Straight through the damage step without stopping to ask anything.
    expect(blocked.phase).not.toBe('firstStrikeDamage');
    expect(blocked.cards['them0']!.zone).toBe('graveyard');

    // And the step itself, reached directly, has nothing to offer either.
    const step = cloneState(declareBlockers(declareAttackers(board, ['you0']).state, [
      { blocker: 'them0', attacker: 'you0' },
    ]).state);
    step.phase = 'firstStrikeDamage';
    step.priority = 0;

    expect(legalActions(step).some((action) => action.kind === 'orderBlockers')).toBe(false);
    expect(validateBlockerOrder(step, 'you0', ['them0'])).not.toBeNull();
  });

  it('refuses an order that is not a rearrangement of the blockers', () => {
    const state = gangBlocked();

    expect(validateBlockerOrder(state, 'you0', ['them0'])).not.toBeNull();
    expect(validateBlockerOrder(state, 'you0', ['them0', 'them0'])).not.toBeNull();
    expect(validateBlockerOrder(state, 'you0', ['them0', 'them1'])).toBeNull();
  });

  it('refuses an order from the defender, whose attack it is not', () => {
    const state = gangBlocked();
    expect(validateBlockerOrder(state, 'them0', ['them0', 'them1'])).not.toBeNull();
  });

  it('leaves the state it was handed untouched', () => {
    const state = gangBlocked();
    const before = JSON.stringify(state);
    reduce(state, { kind: 'orderBlockers', attacker: 'you0', order: ['them1', 'them0'] });
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Every gang-blocked attacker gets ordered, not just the first
// ---------------------------------------------------------------------------

/**
 * Regression: `orderBlockers` handed priority to the defender unconditionally, and
 * `validateBlockerOrder` requires `priority === active`. The handoff was doing double
 * duty as the "already decided" marker, so ordering one attacker permanently killed
 * the ordering decisions `legalActions` had enumerated for every other one — a second
 * gang-blocked attacker silently kept its declaration order.
 *
 * `CardInstance.damageOrderChosen` is that marker now, which lets the handoff go back
 * to meaning only what it says.
 */
describe('blocker ordering covers every gang-blocked attacker', () => {
  function twoGangBlockedAttackers(): GameState {
    const board = battlefield({
      you: [{ power: 2, toughness: 5 }, { power: 2, toughness: 5 }],
      them: [
        { power: 1, toughness: 2 }, { power: 1, toughness: 2 },
        { power: 1, toughness: 2 }, { power: 1, toughness: 2 },
      ],
    });
    const attacked = reduce(board, { kind: 'declareAttackers', attackers: ['you0', 'you1'] }).state;
    return reduce(attacked, {
      kind: 'declareBlockers',
      blocks: [
        { blocker: 'them0', attacker: 'you0' }, { blocker: 'them1', attacker: 'you0' },
        { blocker: 'them2', attacker: 'you1' }, { blocker: 'them3', attacker: 'you1' },
      ],
    }).state;
  }

  it('offers an ordering for both attackers', () => {
    const state = twoGangBlockedAttackers();
    const offered = new Set(legalActions(state)
      .filter(a => a.kind === 'orderBlockers')
      .map(a => (a.kind === 'orderBlockers' ? a.attacker : '')));
    expect([...offered].sort()).toEqual(['you0', 'you1']);
  });

  it('still offers the second attacker after the first is ordered', () => {
    const state = twoGangBlockedAttackers();
    const after = reduce(state, {
      kind: 'orderBlockers', attacker: 'you0', order: ['them1', 'them0'],
    }).state;

    const offered = new Set(legalActions(after)
      .filter(a => a.kind === 'orderBlockers')
      .map(a => (a.kind === 'orderBlockers' ? a.attacker : '')));
    expect([...offered]).toEqual(['you1']);
  });

  it('does not offer the same attacker twice', () => {
    const state = twoGangBlockedAttackers();
    const after = reduce(state, {
      kind: 'orderBlockers', attacker: 'you0', order: ['them1', 'them0'],
    }).state;
    expect(after.cards['you0']!.damageOrderChosen).toBe(true);
    expect(legalActions(after).some(
      a => a.kind === 'orderBlockers' && a.attacker === 'you0',
    )).toBe(false);
  });

  it('keeps the decision with the attacker until every one is ordered', () => {
    const state = twoGangBlockedAttackers();
    const first = reduce(state, {
      kind: 'orderBlockers', attacker: 'you0', order: ['them1', 'them0'],
    }).state;

    // One still outstanding, so it is still the attacking player's decision.
    expect(first.priority).toBe(first.active);
    expect(legalActions(first).some(a => a.kind === 'orderBlockers')).toBe(true);
  });

  it('assigns damage in the order chosen, for both attackers', () => {
    // Each attacker is a 2/5 against two 1/2s: it has exactly enough for the first
    // blocker in its order and nothing for the second. Which creature died is the
    // only observable proof the order was honored, and it survives the combat
    // resolving — unlike blockedBy, which is cleared when combat ends.
    const state = twoGangBlockedAttackers();
    const first = reduce(state, {
      kind: 'orderBlockers', attacker: 'you0', order: ['them1', 'them0'],
    }).state;
    let after = reduce(first, {
      kind: 'orderBlockers', attacker: 'you1', order: ['them3', 'them2'],
    }).state;

    for (let i = 0; i < 8 && after.cards['them1']!.zone === 'battlefield'; i++) {
      const passing = legalActions(after).find(a => a.kind === 'pass');
      if (!passing) break;
      after = reduce(after, passing).state;
    }

    expect(after.cards['them1']!.zone).toBe('graveyard');
    expect(after.cards['them0']!.zone).toBe('battlefield');
    expect(after.cards['them3']!.zone).toBe('graveyard');
    expect(after.cards['them2']!.zone).toBe('battlefield');
  });
});
