/**
 * Pacing, spec §9.4: the game skips only those stops where advancing is the
 * sole legal action — extended from phase stops to stack windows.
 *
 * The complaint these tests answer: you cast a creature, and the game stopped
 * — stack panel up, button reading "Pass" — when nobody could respond. Two
 * taps of pure ceremony on the most common action in the game. `reduce` now
 * settles the position after every action: any priority stop whose holder has
 * no real choice is passed through automatically, so a spell nobody can answer
 * resolves inside the very `reduce` that cast it.
 *
 * Two halves, mirroring the rule:
 *
 * - **What must still stop.** A castable instant is a *real* response window,
 *   whichever player holds it. A pending scry outranks everything. A mulligan
 *   is a real decision. So is a combat declaration with creatures in it.
 * - **What must no longer stop.** A sorcery-speed spell nobody can answer, a
 *   trigger nobody can answer, and a whole chain of them — all settle in one
 *   `reduce`, with every CAST, RESOLVE, and TRIGGER event still emitted in
 *   order, because spec §9.4 skips the *tap*, not the animation.
 */

import { describe, expect, it } from 'vitest';
import type { CardDef, GameState, Phase, StackObject } from '../../src/engine/types';
import { PHASE_ORDER } from '../../src/engine/types';
import { inMulligan, legalActions } from '../../src/engine/actions';
import { beginMulligans, reduce } from '../../src/engine/rules';
import { cloneState, createGame, newInstance } from '../../src/engine/state';
import {
  TEST_DECK,
  TEST_DEFS,
  battlefield,
  gameWith,
  giveLands,
  putCreature,
} from '../fixtures';

const PASS = { kind: 'pass' } as const;

/** The same board, stopped in a different phase. */
function atPhase(state: GameState, phase: Phase): GameState {
  const next = cloneState(state);
  next.phase = phase;
  next.priority = next.active;
  return next;
}

/** Fill in the parts of a `CardDef` no test cares about. */
function makeDef(partial: Partial<CardDef> & { oracleId: string; name: string }): CardDef {
  return {
    manaCost: {},
    cmc: 0,
    colors: [],
    cardTypes: ['creature'],
    subtypes: [],
    oracleText: '',
    keywords: [],
    statics: [],
    triggers: [],
    activated: [],
    spellEffects: [],
    targets: [],
    artist: 'Test Artist',
    art: '',
    image: '',
    ...partial,
  };
}

/** The same game, with one more card definition registered. */
function register(state: GameState, definition: CardDef): GameState {
  const next = cloneState(state);
  next.defs = { ...next.defs, [definition.oracleId]: definition };
  return next;
}

/** "When this creature enters the battlefield, you gain 3 life." */
const WELCOMER_DEF: CardDef = makeDef({
  oracleId: 'pacing-welcomer',
  name: 'Pacing Welcomer',
  manaCost: { W: 1 },
  cmc: 1,
  colors: ['W'],
  power: 1,
  toughness: 1,
  triggers: [{ on: 'onEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 3 }] }],
});

/** "At the beginning of your upkeep, you lose 1 life." */
const HAUNT_DEF: CardDef = makeDef({
  oracleId: 'pacing-haunt',
  name: 'Pacing Haunt',
  manaCost: { B: 1 },
  cmc: 1,
  colors: ['B'],
  power: 1,
  toughness: 1,
  triggers: [{ on: 'onUpkeep', effects: [{ kind: 'loseLife', player: 'you', amount: 1 }] }],
});

const kindsOf = (state: GameState): Set<string> =>
  new Set(legalActions(state).map((action) => action.kind));

// ---------------------------------------------------------------------------
// What must no longer stop
// ---------------------------------------------------------------------------

describe('a stop nobody can use is not a stop', () => {
  it('resolves a sorcery-speed spell in the same reduce when neither player holds an instant', () => {
    // The complaint, verbatim: cast a creature with no possible response, and
    // the game used to stop at "Pass". Player 1's forest and library card are
    // there so the settled game stops at their turn instead of decking out.
    let state = giveLands(gameWith({ library: [[], ['x']] }), 0, 'G', 2);
    state = newInstance(state, 'forest', 1, 'hand').state;
    const made = newInstance(state, 'grizzly-bears', 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: null });

    // No stop: the bears is on the battlefield at the end of the cast itself.
    expect(cast.state.cards[made.id]!.zone).toBe('battlefield');
    expect(cast.state.stack).toEqual([]);
    expect(cast.state.winner).toBeNull();
    // The animator still narrates it: CAST first, then RESOLVE, in order.
    const types = cast.events.map((e) => e.type);
    expect(types.indexOf('CAST')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('CAST')).toBeLessThan(types.indexOf('RESOLVE'));
  });

  it('resolves a trigger nobody can answer in the same reduce that fired it', () => {
    const state = register(gameWith({}), HAUNT_DEF);
    const haunt = putCreature(state, 0, HAUNT_DEF.oracleId);

    const result = reduce(atPhase(haunt.state, 'untap'), PASS);

    // The upkeep trigger went on the stack and came straight back off: the
    // life is already paid and the game stands at the next real decision,
    // the haunt's own attack.
    expect(result.events.some((e) => e.type === 'TRIGGER' && e.on === 'onUpkeep')).toBe(true);
    expect(result.state.players[0].life).toBe(19);
    expect(result.state.stack).toEqual([]);
    expect(result.state.phase).toBe('declareAttackers');
  });

  it('settles a whole chain — spell, then its trigger — in one reduce', () => {
    let state = giveLands(register(gameWith({ library: [[], ['x']] }), WELCOMER_DEF), 0, 'W', 1);
    state = newInstance(state, 'forest', 1, 'hand').state;
    const made = newInstance(state, WELCOMER_DEF.oracleId, 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: null });

    expect(cast.state.cards[made.id]!.zone).toBe('battlefield');
    expect(cast.state.players[0].life).toBe(23);
    expect(cast.state.stack).toEqual([]);
    expect(cast.state.winner).toBeNull();

    // Every event of the chain, in causal order: the cast, the spell
    // resolving, the trigger going up, the trigger resolving.
    const types = cast.events.map((e) => e.type);
    const resolves = types.flatMap((t, i) => (t === 'RESOLVE' ? [i] : []));
    expect(resolves).toHaveLength(2);
    expect(types.indexOf('CAST')).toBeLessThan(resolves[0]!);
    expect(resolves[0]!).toBeLessThan(types.indexOf('TRIGGER'));
    expect(types.indexOf('TRIGGER')).toBeLessThan(resolves[1]!);
  });
});

// ---------------------------------------------------------------------------
// What must still stop
// ---------------------------------------------------------------------------

describe('a real response window still stops the game', () => {
  it('stops when the caster can respond to their own spell', () => {
    // Three forests: two pay for the bears, the third holds up Giant Growth,
    // which has the battlefield bear to point at. That is a real window.
    let state = giveLands(gameWith({}), 0, 'G', 3);
    const target = putCreature(state, 0, 'grizzly-bears');
    state = newInstance(target.state, 'giant-growth', 0, 'hand').state;
    const made = newInstance(state, 'grizzly-bears', 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: null });

    expect(cast.state.stack).toHaveLength(1);
    expect(cast.state.cards[made.id]!.zone).toBe('stack');
    expect(cast.state.priority).toBe(0);
    expect(cast.events.some((e) => e.type === 'RESOLVE')).toBe(false);
    expect(legalActions(cast.state).some((a) => a.kind === 'castSpell')).toBe(true);
  });

  it('stops and hands priority over when the other player holds a castable instant', () => {
    // The same window from the other seat — the holder being the bot changes
    // nothing, because hasRealChoice is asked of whoever priority reaches.
    let state = giveLands(giveLands(gameWith({}), 0, 'G', 2), 1, 'R', 1);
    const target = putCreature(state, 0, 'grizzly-bears');
    state = newInstance(target.state, 'lightning-bolt', 1, 'hand').state;
    const made = newInstance(state, 'grizzly-bears', 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: null });

    expect(cast.state.stack).toHaveLength(1);
    expect(cast.state.cards[made.id]!.zone).toBe('stack');
    expect(cast.state.priority).toBe(1);
    expect(cast.events.some((e) => e.type === 'RESOLVE')).toBe(false);
    expect(legalActions(cast.state).some((a) => a.kind === 'castSpell')).toBe(true);
  });

  it('stops for a pending scry before anything beneath it on the stack', () => {
    const under: StackObject = {
      id: 'spell#under',
      source: 'under',
      controller: 0,
      effects: [{ kind: 'gainLife', player: 'you', amount: 3 }],
      targets: null,
      isTriggered: false,
    };
    const scrying: StackObject = {
      id: 'spell#scry',
      source: 'looker',
      controller: 0,
      effects: [{ kind: 'scry', count: 2 }],
      targets: null,
      isTriggered: false,
    };
    const state = gameWith({ library: [['a', 'b', 'c'], []], stack: [under, scrying] });

    const result = reduce(state, PASS);

    // The scry outranks everything: the game stops on the decision with the
    // rest of the stack still waiting, and offers nothing else at all.
    expect(result.state.pendingScry).toEqual({ player: 0, cards: ['a', 'b'] });
    expect(result.state.stack.map((object) => object.source)).toEqual(['under']);
    expect(kindsOf(result.state)).toEqual(new Set(['scryDecision']));

    // Deciding it releases the rest: the gated spell resolves on its own.
    const decided = reduce(result.state, { kind: 'scryDecision', toBottom: [] });
    expect(decided.state.pendingScry).toBeNull();
    expect(decided.events.some((e) => e.type === 'RESOLVE' && e.card === 'under')).toBe(true);
    expect(decided.state.players[0].life).toBe(23);
  });

  it('stops for the second mulligan decision after the first keep', () => {
    const dealt = beginMulligans(createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 7)).state;

    const kept = reduce(dealt, { kind: 'keepHand', toBottom: [] });

    expect(inMulligan(kept.state)).toBe(true);
    expect(kept.state.priority).toBe(1);
    expect(kindsOf(kept.state)).toEqual(new Set(['mulligan', 'keepHand']));
  });

  it('stops at declare attackers when there is a real attack to declare', () => {
    const board = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });

    const result = reduce(atPhase(board, 'main1'), PASS);

    expect(result.state.phase).toBe('declareAttackers');
    expect(result.state.priority).toBe(0);
    expect(result.state.winner).toBeNull();
  });

  it('stops at declare blockers when the defender has a real block to declare', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2 }],
    });

    const attacked = reduce(board, { kind: 'declareAttackers', attackers: ['you0'] });

    expect(attacked.state.phase).toBe('declareBlockers');
    expect(attacked.state.priority).toBe(1);
    expect(attacked.state.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The loop is bounded
// ---------------------------------------------------------------------------

describe('the settle loop terminates', () => {
  it('plays a game in which nobody ever has a choice to its end, rather than hanging', () => {
    // Empty hands, empty boards, one card each: no real choice ever arises,
    // so a single pass rolls the whole game forward — every phase still
    // reported — until a draw from an empty library decides it.
    const state = gameWith({ library: [['a'], ['b']] });

    const result = reduce(state, PASS);

    expect(result.state.winner).toBe(0);
    expect(result.events.some((e) => e.type === 'WIN')).toBe(true);
    // More than one turn's worth of phases passed through a single reduce.
    expect(result.events.filter((e) => e.type === 'PHASE').length).toBeGreaterThan(
      PHASE_ORDER.length,
    );
  });
});
