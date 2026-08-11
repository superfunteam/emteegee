/**
 * The reducer: priority, the stack, phases, and state-based actions.
 *
 * Every engine mutator takes a `GameState` and returns `{ state, events }`, so
 * these tests read `reduce(state, action).state` and never chain a
 * `ReduceResult` back into a mutator.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDef,
  CardId,
  Effect,
  GameState,
  Phase,
  StackObject,
  TargetSelection,
} from '../../src/engine/types';
import { PHASE_ORDER } from '../../src/engine/types';
import { cloneState, newInstance } from '../../src/engine/state';
import { advancePhase, reduce, resolveTop, stateBasedActions } from '../../src/engine/rules';
import { battlefield, gameWith, giveLands } from '../fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = { kind: 'pass' } as const;

/** The filter an effect uses when the selection has already been decided. */
const SELECTED = {};

/**
 * A stack object a test can name. `source` is whatever card the object came
 * from; the fixtures materialise one in the stack zone if it does not exist.
 */
function pending(
  source: CardId,
  effects: Effect[] = [],
  targets: TargetSelection = null,
): StackObject {
  return { id: `object-${source}`, source, controller: 0, effects, targets, isTriggered: false };
}

/** The same board, stopped in a different phase. */
function atPhase(state: GameState, phase: Phase): GameState {
  const next = cloneState(state);
  next.phase = phase;
  next.priority = next.active;
  return next;
}

/** The same board with these objects waiting on the stack, bottom to top. */
function withStack(state: GameState, objects: StackObject[]): GameState {
  const next = cloneState(state);
  next.stack = [...objects];
  return next;
}

/** Reach into a clone and set the fields the fixture builders do not expose. */
function tweak(state: GameState, card: CardId, patch: (c: GameState['cards'][string]) => void): GameState {
  const next = cloneState(state);
  patch(next.cards[card]!);
  return next;
}

const AURA_DEF: CardDef = {
  oracleId: 'test-aura',
  name: 'Test Aura',
  manaCost: { W: 1 },
  cmc: 1,
  colors: ['W'],
  cardTypes: ['enchantment'],
  subtypes: ['Aura'],
  oracleText: 'Enchanted creature gets +1/+1.',
  keywords: [],
  statics: [
    {
      kind: 'aura',
      attachTo: { zone: 'battlefield', cardTypes: ['creature'], controller: 'any' },
      power: 1,
      toughness: 1,
      keywords: [],
    },
  ],
  triggers: [],
  activated: [],
  spellEffects: [],
  targets: [],
  artist: 'Test Artist',
  art: '',
  image: '',
};

/** An aura on player 0's battlefield, already attached to `host`. */
function withAura(state: GameState, host: CardId): { state: GameState; id: CardId } {
  const registered = cloneState(state);
  registered.defs = { ...registered.defs, [AURA_DEF.oracleId]: AURA_DEF };

  const made = newInstance(registered, AURA_DEF.oracleId, 0, 'battlefield');
  const next = cloneState(made.state);
  next.cards[made.id]!.attachedTo = host;
  return { state: next, id: made.id };
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

describe('the stack', () => {
  it('resolves last in, first out', () => {
    const state = gameWith({ stack: [pending('first'), pending('second')] });

    const top = reduce(state, PASS);
    expect(top.events.filter((e) => e.type === 'RESOLVE').map((e) => e.card)).toEqual(['second']);

    const rest = reduce(top.state, PASS);
    expect(rest.events.filter((e) => e.type === 'RESOLVE').map((e) => e.card)).toEqual(['first']);
    expect(rest.state.stack).toEqual([]);
  });

  it('pops the last object and puts a resolved spell in its owner graveyard', () => {
    const state = gameWith({ stack: [pending('first'), pending('second')] });
    const result = resolveTop(state);

    expect(result.state.stack.map((object) => object.source)).toEqual(['first']);
    expect(result.state.cards['second']!.zone).toBe('graveyard');
    expect(state.stack).toHaveLength(2);
  });

  it('resolving an empty stack is a no-op rather than a throw', () => {
    const state = gameWith({});
    expect(resolveTop(state).events).toEqual([]);
  });

  it('puts a resolved creature spell onto the battlefield, summoning sick', () => {
    let state = giveLands(gameWith({}), 0, 'G', 2);
    const made = newInstance(state, 'grizzly-bears', 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: null });
    expect(cast.state.cards[made.id]!.zone).toBe('stack');
    expect(cast.state.stack).toHaveLength(1);

    const resolved = reduce(cast.state, PASS);
    expect(resolved.state.cards[made.id]!.zone).toBe('battlefield');
    expect(resolved.state.cards[made.id]!.summonedThisTurn).toBe(true);
    expect(resolved.state.stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// State-based actions
// ---------------------------------------------------------------------------

describe('state-based actions', () => {
  it('runs after a stack resolution, not only at phase boundaries', () => {
    const board = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const state = withStack(board, [
      pending('you0', [{ kind: 'damage', target: SELECTED, amount: 2 }], ['you0']),
    ]);

    const result = reduce(state, PASS);

    expect(result.state.cards['you0']!.zone).toBe('graveyard');
    expect(result.events.some((e) => e.type === 'DIE' && e.card === 'you0')).toBe(true);
    // The phase never moved: the sweep came from the resolution, not a boundary.
    expect(result.state.phase).toBe('declareAttackers');
  });

  it('destroys a creature with lethal damage marked', () => {
    const state = battlefield({ you: [{ power: 1, toughness: 1, damage: 1 }], them: [] });
    const result = stateBasedActions(state);

    expect(result.state.cards['you0']!.zone).toBe('graveyard');
    expect(result.events.some((e) => e.type === 'DIE' && e.card === 'you0')).toBe(true);
    expect(state.cards['you0']!.zone).toBe('battlefield');
  });

  it('destroys a creature whose toughness has been reduced to zero', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, tempPump: { power: 0, toughness: -2 } }],
      them: [],
    });
    expect(stateBasedActions(state).state.cards['you0']!.zone).toBe('graveyard');
  });

  it('puts an aura into the graveyard once its host is gone', () => {
    // The aura is worth +1/+1, so two damage is what it takes to kill a 2/2 wearing it.
    const board = battlefield({ you: [{ power: 2, toughness: 2, damage: 3 }], them: [] });
    const aura = withAura(board, 'you0');

    const result = stateBasedActions(aura.state);

    expect(result.state.cards['you0']!.zone).toBe('graveyard');
    expect(result.state.cards[aura.id]!.zone).toBe('graveyard');
  });

  it('leaves a settled board alone and emits nothing', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 1, toughness: 1 }] });
    const result = stateBasedActions(state);

    expect(result.events).toEqual([]);
    expect(result.state.cards['you0']!.zone).toBe('battlefield');
    expect(result.state.winner).toBeNull();
  });

  it('ends the game when a player is at zero life', () => {
    const result = reduce(gameWith({ life: [0, 20] }), PASS);

    expect(result.state.winner).toBe(1);
    expect(result.events.some((e) => e.type === 'WIN' && e.player === 1)).toBe(true);
  });

  it('ends the game when a player draws from an empty library', () => {
    const state = gameWith({ library: [['a'], []], phase: 'upkeep', active: 1 });
    const result = reduce(state, PASS);

    expect(result.state.players[1].drewFromEmpty).toBe(true);
    expect(result.state.winner).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

describe('phases', () => {
  it('untaps the new active player permanents and clears summoning sickness', () => {
    const board = battlefield({
      you: [],
      them: [{ power: 2, toughness: 2, tapped: true, summonedThisTurn: true }],
    });
    const result = reduce(atPhase(board, 'cleanup'), PASS);

    expect(result.state.active).toBe(1);
    expect(result.state.turn).toBe(2);
    expect(result.state.cards['them0']!.tapped).toBe(false);
    expect(result.state.cards['them0']!.summonedThisTurn).toBe(false);
    expect(result.events.some((e) => e.type === 'UNTAP' && e.card === 'them0')).toBe(true);
  });

  it('clears temporary pump, granted keywords, and marked damage at cleanup', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2, tempPump: { power: 3, toughness: 3 }, damage: 3 }],
      them: [],
    });
    const state = tweak(atPhase(board, 'end'), 'you0', (card) => {
      card.tempKeywords = ['flying'];
    });

    const result = reduce(state, PASS);

    expect(result.state.cards['you0']!.tempPump).toEqual({ power: 0, toughness: 0 });
    expect(result.state.cards['you0']!.tempKeywords).toEqual([]);
    expect(result.state.cards['you0']!.damage).toBe(0);
    // Damage and the pump wear off together, so the creature survives.
    expect(result.state.cards['you0']!.zone).toBe('battlefield');
  });

  it('draws for the active player at the draw step', () => {
    const state = gameWith({ library: [['a'], ['b']], phase: 'upkeep', active: 1 });
    const result = reduce(state, PASS);

    expect(result.events.some((e) => e.type === 'DRAW' && e.player === 1 && e.card === 'b')).toBe(true);
    expect(result.state.players[1].hand).toContain('b');
  });

  it('skips the turn-one draw for player 0, who is on the play', () => {
    const state = gameWith({ library: [['a', 'b'], ['c']], phase: 'upkeep', active: 0 });
    const result = reduce(state, PASS);

    expect(result.events.filter((e) => e.type === 'DRAW' && e.player === 0)).toEqual([]);
    expect(result.state.players[0].library).toEqual(['a', 'b']);
  });

  it('skips stops where advancing is the only thing to do, and reports every phase', () => {
    const state = gameWith({ hand: [[], []], library: [['a'], ['b']], phase: 'main1' });
    const result = reduce(state, PASS);

    const phases = result.events.filter((e) => e.type === 'PHASE').map((e) => e.phase);
    expect(phases.length).toBeGreaterThan(1);
    expect(phases).toContain('end');
    expect(phases).toContain('cleanup');
    // Untap and draw are passed through, not skipped silently: the animator
    // still gets to show them.
    expect(phases).toContain('untap');
    expect(phases).toContain('draw');
    expect(phases.length).toBeLessThanOrEqual(PHASE_ORDER.length);
    expect(result.state.active).toBe(1);
  });

  it('stops at a phase where the player with priority has a real decision', () => {
    const state = atPhase(battlefield({ you: [{ power: 2, toughness: 2 }], them: [] }), 'main1');
    const result = advancePhase(state);

    expect(result.state.phase).toBe('declareAttackers');
    expect(result.state.priority).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('reduce', () => {
  it('throws on an action the generator never offered', () => {
    expect(() => reduce(gameWith({}), { kind: 'playLand', card: 'nothing' })).toThrow(/legal/i);
  });

  it('never mutates the state handed in', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const before = JSON.stringify(state);

    reduce(state, { kind: 'declareAttackers', attackers: ['you0'] });

    expect(JSON.stringify(state)).toBe(before);
  });

  it('plays a land and marks the land drop as spent', () => {
    let state = gameWith({});
    const made = newInstance(state, 'forest', 0, 'hand');
    state = made.state;

    const result = reduce(state, { kind: 'playLand', card: made.id });

    expect(result.state.cards[made.id]!.zone).toBe('battlefield');
    expect(result.state.players[0].landPlayedThisTurn).toBe(true);
    expect(result.events.some((e) => e.type === 'PLAY' && e.card === made.id)).toBe(true);
  });

  it('carries an unblocked attacker all the way through the damage step', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const result = reduce(state, { kind: 'declareAttackers', attackers: ['you0'] });

    expect(result.events.some((e) => e.type === 'ATTACK')).toBe(true);
    expect(result.state.players[1].life).toBe(18);
    expect(result.state.cards['you0']!.attacking).toBe(false);
  });
});
