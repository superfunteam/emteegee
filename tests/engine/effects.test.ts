import { describe, it, expect } from 'vitest';
import { applyEffect, applyEffects } from '../../src/engine/effects';
import { cloneState, hasKeyword, powerOf, toughnessOf } from '../../src/engine/state';
import type {
  CardId,
  Effect,
  GameState,
  PlayerId,
  StackObject,
  TargetFilter,
  TokenSpec,
  Trigger,
} from '../../src/engine/types';
import { STACK_CAP, STARTING_LIFE } from '../../src/engine/types';
import { TEST_DEFS, TEST_DECK, battlefield, gameWith, putCreature } from '../fixtures';
import { createGame } from '../../src/engine/state';

const game = (): GameState => createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 42);

/** One 2/2 of yours on the table, plus a 3/3 of theirs. */
const board = (): GameState =>
  battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 3, toughness: 3 }] });

const ANY_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] };

const SOLDIER: TokenSpec = {
  name: 'Soldier',
  power: 1,
  toughness: 1,
  colors: ['W'],
  subtypes: ['Soldier'],
  keywords: [],
  art: 'soldier.jpg',
};

/** Give one card's definition a trigger, without touching the state handed in. */
function withTrigger(base: GameState, card: CardId, trigger: Trigger): GameState {
  const next = cloneState(base);
  const existing = next.defs[next.cards[card]!.oracleId]!;
  return {
    ...next,
    defs: { ...next.defs, [existing.oracleId]: { ...existing, triggers: [...existing.triggers, trigger] } },
  };
}

const GAIN_LIFE_TRIGGER: Trigger = {
  on: 'onLifeGain',
  effects: [{ kind: 'addCounter', target: 'self', counter: '+1/+1', count: 1 }],
};

const stackObject = (id: string, source: CardId, controller: PlayerId): StackObject => ({
  id,
  source,
  controller,
  effects: [],
  targets: null,
  isTriggered: false,
});

const pump = (power: number, toughness: number): Effect => ({
  kind: 'pump',
  target: 'self',
  power,
  toughness,
  duration: 'endOfTurn',
});

// ---------------------------------------------------------------------------
// damage
// ---------------------------------------------------------------------------

describe('damage', () => {
  it('reduces the targeted player life total and emits DAMAGE then LIFE_CHANGE', () => {
    const r = applyEffect(game(), { kind: 'damage', target: 'player', amount: 3 }, 'src', 0, 'player1');

    expect(r.state.players[1].life).toBe(STARTING_LIFE - 3);
    expect(r.state.players[0].life).toBe(STARTING_LIFE);
    expect(r.events).toEqual([
      { type: 'DAMAGE', source: 'src', target: 1, amount: 3, isPlayer: true },
      { type: 'LIFE_CHANGE', player: 1, from: STARTING_LIFE, to: STARTING_LIFE - 3 },
    ]);
  });

  it('points at the opponent when no player was selected', () => {
    const r = applyEffect(game(), { kind: 'damage', target: 'player', amount: 2 }, 'src', 0, null);
    expect(r.state.players[1].life).toBe(STARTING_LIFE - 2);
  });

  it('marks a creature without removing it', () => {
    const r = applyEffect(board(), { kind: 'damage', target: ANY_CREATURE, amount: 1 }, 'src', 0, ['you0']);

    expect(r.state.cards['you0']!.damage).toBe(1);
    expect(r.state.cards['you0']!.zone).toBe('battlefield');
    expect(r.state.players[0].battlefield).toContain('you0');
    expect(r.events).toEqual([{ type: 'DAMAGE', source: 'src', target: 'you0', amount: 1, isPlayer: false }]);
  });

  it('leaves a lethally damaged creature on the battlefield for state-based actions to kill', () => {
    const r = applyEffect(board(), { kind: 'damage', target: ANY_CREATURE, amount: 5 }, 'src', 0, ['you0']);

    expect(r.state.cards['you0']!.damage).toBe(5);
    expect(r.state.cards['you0']!.zone).toBe('battlefield');
    expect(r.events.some((e) => e.type === 'DIE')).toBe(false);
  });

  it('accumulates onto damage already marked', () => {
    const first = applyEffect(board(), { kind: 'damage', target: ANY_CREATURE, amount: 1 }, 'src', 0, ['you0']);
    const second = applyEffect(first.state, { kind: 'damage', target: ANY_CREATURE, amount: 2 }, 'src', 0, ['you0']);
    expect(second.state.cards['you0']!.damage).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// destroy, exile, sacrifice, returnToHand
// ---------------------------------------------------------------------------

describe('zone-changing effects', () => {
  it('destroy puts a creature into its owner graveyard and emits ZONE_CHANGE and DIE', () => {
    const r = applyEffect(board(), { kind: 'destroy', target: ANY_CREATURE }, 'src', 0, ['them0']);

    expect(r.state.cards['them0']!.zone).toBe('graveyard');
    expect(r.state.players[1].graveyard).toContain('them0');
    expect(r.state.players[1].battlefield).not.toContain('them0');
    expect(r.events).toEqual([
      { type: 'ZONE_CHANGE', card: 'them0', from: 'battlefield', to: 'graveyard' },
      { type: 'DIE', card: 'them0' },
    ]);
  });

  it('destroy fires the onDies triggers of the creature that died', () => {
    const s = withTrigger(board(), 'you0', { on: 'onDies', effects: [{ kind: 'gainLife', player: 'you', amount: 2 }] });
    const r = applyEffect(s, { kind: 'destroy', target: ANY_CREATURE }, 'src', 0, ['you0']);

    expect(r.events.some((e) => e.type === 'TRIGGER' && e.on === 'onDies' && e.source === 'you0')).toBe(true);
    expect(r.state.stack).toHaveLength(1);
    expect(r.state.stack[0]!.isTriggered).toBe(true);
  });

  it('exile removes a permanent from the battlefield without it dying', () => {
    const r = applyEffect(board(), { kind: 'exile', target: ANY_CREATURE }, 'src', 0, ['them0']);

    expect(r.state.cards['them0']!.zone).toBe('exile');
    expect(r.state.players[1].exile).toContain('them0');
    expect(r.events.some((e) => e.type === 'DIE')).toBe(false);
  });

  it('sacrifice puts your own creature into the graveyard and it dies', () => {
    const r = applyEffect(board(), { kind: 'sacrifice', target: ANY_CREATURE }, 'you0', 0, ['you0']);

    expect(r.state.cards['you0']!.zone).toBe('graveyard');
    expect(r.events.some((e) => e.type === 'DIE' && e.card === 'you0')).toBe(true);
  });

  it('returnToHand bounces a permanent to its owner hand', () => {
    const r = applyEffect(board(), { kind: 'returnToHand', target: ANY_CREATURE }, 'src', 0, ['them0']);

    expect(r.state.cards['them0']!.zone).toBe('hand');
    expect(r.state.players[1].hand).toContain('them0');
    expect(r.events).toEqual([{ type: 'ZONE_CHANGE', card: 'them0', from: 'battlefield', to: 'hand' }]);
  });
});

// ---------------------------------------------------------------------------
// draw and discard
// ---------------------------------------------------------------------------

describe('draw', () => {
  it('moves the top card of the library into hand and emits DRAW', () => {
    const s = game();
    const top = s.players[0].library[0]!;
    const r = applyEffect(s, { kind: 'draw', player: 'you', count: 2 }, 'src', 0, null);

    expect(r.state.players[0].hand).toHaveLength(s.players[0].hand.length + 2);
    expect(r.state.players[0].hand).toContain(top);
    expect(r.state.cards[top]!.zone).toBe('hand');
    expect(r.events.filter((e) => e.type === 'DRAW')).toHaveLength(2);
  });

  it('draws for the opponent when the effect says so', () => {
    const s = game();
    const r = applyEffect(s, { kind: 'draw', player: 'opponent', count: 1 }, 'src', 0, null);
    expect(r.state.players[1].hand).toHaveLength(s.players[1].hand.length + 1);
    expect(r.state.players[0].hand).toHaveLength(s.players[0].hand.length);
  });

  it('flags an empty library instead of throwing, leaving the loss to state-based actions', () => {
    const s = gameWith({ library: [[], ['a']] });
    const r = applyEffect(s, { kind: 'draw', player: 'you', count: 1 }, 'src', 0, null);

    expect(r.state.players[0].drewFromEmpty).toBe(true);
    expect(r.state.winner).toBeNull();
    expect(r.events.filter((e) => e.type === 'DRAW')).toHaveLength(0);
  });
});

describe('discard', () => {
  it('puts cards from hand into the graveyard', () => {
    const s = gameWith({ hand: [['a', 'b', 'c'], []] });
    const r = applyEffect(s, { kind: 'discard', player: 'you', count: 2 }, 'src', 0, null);

    expect(r.state.players[0].hand).toEqual(['c']);
    expect(r.state.players[0].graveyard).toEqual(['a', 'b']);
    expect(r.events.filter((e) => e.type === 'ZONE_CHANGE')).toHaveLength(2);
  });

  it('discards what it can from a hand smaller than the count', () => {
    const s = gameWith({ hand: [[], ['x']] });
    const r = applyEffect(s, { kind: 'discard', player: 'opponent', count: 2 }, 'src', 0, null);

    expect(r.state.players[1].hand).toEqual([]);
    expect(r.state.players[1].graveyard).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// life
// ---------------------------------------------------------------------------

describe('life', () => {
  it('gainLife raises the life total and emits LIFE_CHANGE', () => {
    const r = applyEffect(game(), { kind: 'gainLife', player: 'you', amount: 3 }, 'src', 0, null);

    expect(r.state.players[0].life).toBe(STARTING_LIFE + 3);
    expect(r.events).toEqual([
      { type: 'LIFE_CHANGE', player: 0, from: STARTING_LIFE, to: STARTING_LIFE + 3 },
    ]);
  });

  it('gainLife fires the onLifeGain triggers of the gaining player permanents', () => {
    const s = withTrigger(board(), 'you0', GAIN_LIFE_TRIGGER);
    const r = applyEffect(s, { kind: 'gainLife', player: 'you', amount: 3 }, 'src', 0, null);

    expect(r.events.some((e) => e.type === 'TRIGGER' && e.on === 'onLifeGain' && e.source === 'you0')).toBe(true);
    expect(r.state.stack).toHaveLength(1);
    expect(r.state.stack[0]).toMatchObject({ source: 'you0', controller: 0, isTriggered: true });
    expect(r.state.stack[0]!.effects).toEqual(GAIN_LIFE_TRIGGER.effects);
  });

  it('does not fire the opponent onLifeGain triggers when you gain life', () => {
    const s = withTrigger(board(), 'them0', GAIN_LIFE_TRIGGER);
    const r = applyEffect(s, { kind: 'gainLife', player: 'you', amount: 3 }, 'src', 0, null);

    expect(r.events.some((e) => e.type === 'TRIGGER')).toBe(false);
    expect(r.state.stack).toHaveLength(0);
  });

  it('loseLife lowers the life total without emitting DAMAGE', () => {
    const r = applyEffect(game(), { kind: 'loseLife', player: 'opponent', amount: 4 }, 'src', 0, null);

    expect(r.state.players[1].life).toBe(STARTING_LIFE - 4);
    expect(r.events).toEqual([
      { type: 'LIFE_CHANGE', player: 1, from: STARTING_LIFE, to: STARTING_LIFE - 4 },
    ]);
  });

  it('does not clamp a life total at zero — state-based actions decide the game', () => {
    const r = applyEffect(gameWith({ life: [2, 20] }), { kind: 'loseLife', player: 'you', amount: 5 }, 'src', 0, null);
    expect(r.state.players[0].life).toBe(-3);
    expect(r.state.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pump, keywords, counters
// ---------------------------------------------------------------------------

describe('pump', () => {
  it('is temporary and stacks additively — two Giant Growths are +6/+6', () => {
    const first = applyEffect(board(), pump(3, 3), 'you0', 0, ['you0']);
    const second = applyEffect(first.state, pump(3, 3), 'you0', 0, ['you0']);

    expect(second.state.cards['you0']!.tempPump).toEqual({ power: 6, toughness: 6 });
    expect(powerOf(second.state, 'you0')).toBe(8);
    expect(toughnessOf(second.state, 'you0')).toBe(8);
  });

  it('pumps every card in the selection', () => {
    const spread: Effect = {
      kind: 'pump',
      target: ANY_CREATURE,
      power: 1,
      toughness: 1,
      duration: 'endOfTurn',
    };
    const r = applyEffect(board(), spread, 'src', 0, ['you0', 'them0']);
    expect(powerOf(r.state, 'you0')).toBe(3);
    expect(powerOf(r.state, 'them0')).toBe(4);
  });

  it('writes +1/+1 counters when the duration is permanent', () => {
    const r = applyEffect(
      board(),
      { kind: 'pump', target: 'self', power: 1, toughness: 1, duration: 'permanent' },
      'you0',
      0,
      null,
    );

    expect(r.state.cards['you0']!.counters['+1/+1']).toBe(1);
    expect(r.state.cards['you0']!.tempPump).toEqual({ power: 0, toughness: 0 });
  });

  it('throws on a permanent pump the instance model cannot represent', () => {
    expect(() =>
      applyEffect(
        board(),
        { kind: 'pump', target: 'self', power: 2, toughness: 0, duration: 'permanent' },
        'you0',
        0,
        null,
      ),
    ).toThrow(/permanent/i);
  });
});

describe('grantKeyword', () => {
  it('grants a keyword until end of turn', () => {
    const r = applyEffect(
      board(),
      { kind: 'grantKeyword', target: 'self', keyword: 'flying', duration: 'endOfTurn' },
      'you0',
      0,
      null,
    );

    expect(hasKeyword(r.state, 'you0', 'flying')).toBe(true);
    expect(r.state.cards['you0']!.tempKeywords).toEqual(['flying']);
  });

  it('does not list the same keyword twice', () => {
    const grant: Effect = { kind: 'grantKeyword', target: 'self', keyword: 'trample', duration: 'endOfTurn' };
    const r = applyEffects(board(), [grant, grant], 'you0', 0, null);
    expect(r.state.cards['you0']!.tempKeywords).toEqual(['trample']);
  });
});

describe('addCounter', () => {
  it('is permanent and changes power and toughness', () => {
    const r = applyEffect(
      board(),
      { kind: 'addCounter', target: 'self', counter: '+1/+1', count: 2 },
      'you0',
      0,
      null,
    );

    expect(r.state.cards['you0']!.counters['+1/+1']).toBe(2);
    expect(r.state.cards['you0']!.tempPump).toEqual({ power: 0, toughness: 0 });
    expect(powerOf(r.state, 'you0')).toBe(4);
    expect(r.events).toEqual([{ type: 'COUNTER_ADD', card: 'you0', counter: '+1/+1', count: 2 }]);
  });

  it('shrinks a creature with -1/-1 counters', () => {
    const r = applyEffect(
      board(),
      { kind: 'addCounter', target: ANY_CREATURE, counter: '-1/-1', count: 1 },
      'src',
      0,
      ['them0'],
    );
    expect(powerOf(r.state, 'them0')).toBe(2);
    expect(toughnessOf(r.state, 'them0')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// tap and untap
// ---------------------------------------------------------------------------

describe('tap and untap', () => {
  it('taps an untapped permanent and emits TAP', () => {
    const r = applyEffect(board(), { kind: 'tap', target: ANY_CREATURE }, 'src', 0, ['them0']);
    expect(r.state.cards['them0']!.tapped).toBe(true);
    expect(r.events).toEqual([{ type: 'TAP', card: 'them0' }]);
  });

  it('says nothing about a permanent that is already tapped', () => {
    const tapped = applyEffect(board(), { kind: 'tap', target: ANY_CREATURE }, 'src', 0, ['them0']).state;
    const again = applyEffect(tapped, { kind: 'tap', target: ANY_CREATURE }, 'src', 0, ['them0']);
    expect(again.events).toEqual([]);
  });

  it('untaps a tapped permanent and emits UNTAP', () => {
    const tapped = applyEffect(board(), { kind: 'tap', target: ANY_CREATURE }, 'src', 0, ['you0']).state;
    const r = applyEffect(tapped, { kind: 'untap', target: ANY_CREATURE }, 'src', 0, ['you0']);

    expect(r.state.cards['you0']!.tapped).toBe(false);
    expect(r.events).toEqual([{ type: 'UNTAP', card: 'you0' }]);
  });
});

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

describe('createToken', () => {
  it('puts real instances onto the battlefield and emits one TOKEN_CREATE each', () => {
    const s = game();
    const before = s.players[0].battlefield.length;
    const r = applyEffect(s, { kind: 'createToken', token: SOLDIER, count: 2 }, 'src', 0, null);

    expect(r.state.players[0].battlefield).toHaveLength(before + 2);
    expect(r.events.filter((e) => e.type === 'TOKEN_CREATE')).toHaveLength(2);

    const made = r.state.players[0].battlefield;
    for (const id of made) {
      const card = r.state.cards[id]!;
      expect(card.isToken).toBe(true);
      expect(card.tokenSpec).toEqual(SOLDIER);
      expect(card.zone).toBe('battlefield');
      expect(card.controller).toBe(0);
      expect(card.summonedThisTurn).toBe(true);
      expect(powerOf(r.state, id)).toBe(1);
    }
    expect(new Set(made).size).toBe(made.length);
  });

  it('registers a synthesized definition, shared by every copy of the token', () => {
    const s = game();
    const r = applyEffect(s, { kind: 'createToken', token: SOLDIER, count: 2 }, 'src', 0, null);

    const ids = r.state.players[0].battlefield;
    const oracleId = r.state.cards[ids[0]!]!.oracleId;
    expect(r.state.cards[ids[1]!]!.oracleId).toBe(oracleId);

    const synthesized = r.state.defs[oracleId]!;
    expect(synthesized).toBeDefined();
    expect(synthesized.name).toBe('Soldier');
    expect(synthesized.power).toBe(1);
    expect(synthesized.toughness).toBe(1);
    expect(synthesized.cardTypes).toEqual(['creature']);
    expect(s.defs[oracleId]).toBeUndefined();
  });

  it('gives the token its keywords', () => {
    const flier: TokenSpec = { ...SOLDIER, name: 'Angel', power: 4, toughness: 4, keywords: ['flying'] };
    const r = applyEffect(game(), { kind: 'createToken', token: flier, count: 1 }, 'src', 0, null);
    const id = r.state.players[0].battlefield[0]!;
    expect(hasKeyword(r.state, id, 'flying')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scry, mana, counterSpell
// ---------------------------------------------------------------------------

describe('scry', () => {
  it('parks the decision on the state instead of resolving it', () => {
    const s = game();
    const top = s.players[0].library.slice(0, 2);
    const r = applyEffect(s, { kind: 'scry', count: 2 }, 'src', 0, null);

    expect(r.state.pendingScry).toEqual({ player: 0, cards: top });
    expect(r.state.players[0].hand).toEqual(s.players[0].hand);
    expect(r.events).toEqual([{ type: 'SCRY', player: 0, count: 2 }]);
  });

  it('lifts the cards off the library until the decision puts them back', () => {
    // Not a detail. Every scry card in the pool draws in the same breath —
    // "Scry 1. Draw a card." — and `applyEffects` keeps going while the question
    // is outstanding. Leaving the cards on top means that draw takes one of them
    // into hand while `pendingScry` still holds it, and `scryDecision` then puts
    // a card back into a library that no longer has any business holding it: one
    // card in two zones at once.
    const s = game();
    const top = s.players[0].library.slice(0, 2);
    const rest = s.players[0].library.slice(2);
    const r = applyEffect(s, { kind: 'scry', count: 2 }, 'src', 0, null);

    expect(r.state.players[0].library).toEqual(rest);
    for (const id of top) expect(r.state.players[0].library).not.toContain(id);
  });

  it('draws from under the parked cards, so nothing is ever in two zones at once', () => {
    const s = game();
    const [first, second, third] = s.players[0].library;
    const scried = applyEffect(s, { kind: 'scry', count: 2 }, 'src', 0, null).state;
    const drawn = applyEffect(scried, { kind: 'draw', player: 'you', count: 1 }, 'src', 0, null).state;

    // The card drawn is the one beneath what is being looked at, and neither of
    // the parked cards has moved anywhere.
    expect(drawn.players[0].hand).toContain(third);
    expect(drawn.players[0].hand).not.toContain(first);
    expect(drawn.players[0].hand).not.toContain(second);
    expect(drawn.pendingScry).toEqual({ player: 0, cards: [first, second] });
    expect(drawn.players[0].library).not.toContain(third);
  });

  it('does nothing on an empty library', () => {
    const r = applyEffect(gameWith({ library: [[], []] }), { kind: 'scry', count: 1 }, 'src', 0, null);
    expect(r.state.pendingScry).toBeNull();
    expect(r.events).toEqual([]);
  });

  it('hands a card back to a draw that would otherwise find the library empty', () => {
    // Preordain on a two-card library: it looks at both, then draws — and what it
    // draws is one of the two. Decking the player here would be an artifact of
    // parking the cards, not a rule.
    const s = gameWith({ library: [['a', 'b'], ['x']] });
    const scried = applyEffect(s, { kind: 'scry', count: 2 }, 'src', 0, null).state;
    expect(scried.players[0].library).toEqual([]);

    const r = applyEffect(scried, { kind: 'draw', player: 'you', count: 1 }, 'src', 0, null);

    expect(r.state.players[0].hand).toEqual(['a']);
    expect(r.state.players[0].drewFromEmpty).toBe(false);
    // The scry keeps what is left, and still has a decision to make about it.
    expect(r.state.pendingScry).toEqual({ player: 0, cards: ['b'] });
  });

  it('ends the scry rather than leaving a decision about no cards', () => {
    const s = gameWith({ library: [['a'], ['x']] });
    const scried = applyEffect(s, { kind: 'scry', count: 1 }, 'src', 0, null).state;
    const r = applyEffect(scried, { kind: 'draw', player: 'you', count: 1 }, 'src', 0, null);

    expect(r.state.players[0].hand).toEqual(['a']);
    expect(r.state.pendingScry).toBeNull();
    expect(r.state.players[0].drewFromEmpty).toBe(false);
  });

  it('still decks a player whose library is genuinely gone', () => {
    const s = gameWith({ library: [[], []] });
    const r = applyEffect(s, { kind: 'draw', player: 'you', count: 1 }, 'src', 0, null);
    expect(r.state.players[0].drewFromEmpty).toBe(true);
  });
});

describe('addMana', () => {
  it('floats one mana per color in the controller pool', () => {
    const r = applyEffect(game(), { kind: 'addMana', colors: ['G', 'G', 'W'] }, 'src', 0, null);
    expect(r.state.players[0].manaPool).toEqual({ G: 2, W: 1 });
    expect(r.state.players[1].manaPool).toEqual({});
  });
});

describe('counterSpell', () => {
  it('removes the top stack object, emits COUNTERED, and graveyards the spell', () => {
    const s = gameWith({ stack: [stackObject('s0', 'first', 1), stackObject('s1', 'second', 1)] });
    const r = applyEffect(s, { kind: 'counterSpell' }, 'src', 0, null);

    expect(r.state.stack.map((o) => o.source)).toEqual(['first']);
    expect(r.events).toEqual([
      { type: 'COUNTERED', card: 'second' },
      { type: 'ZONE_CHANGE', card: 'second', from: 'stack', to: 'graveyard' },
    ]);
    expect(r.state.players[1].graveyard).toContain('second');
    expect(r.state.cards['second']!.zone).toBe('graveyard');
  });

  it('skips itself and counters the top object it did not come from', () => {
    const s = gameWith({ stack: [stackObject('s0', 'victim', 1), stackObject('s1', 'me', 0)] });
    const r = applyEffect(s, { kind: 'counterSpell' }, 'me', 0, null);

    expect(r.state.stack.map((o) => o.source)).toEqual(['me']);
    expect(r.events.some((e) => e.type === 'COUNTERED' && e.card === 'victim')).toBe(true);
  });

  it('fizzles when the stack holds nothing else', () => {
    const s = gameWith({ stack: [stackObject('s0', 'me', 0)] });
    const r = applyEffect(s, { kind: 'counterSpell' }, 'me', 0, null);

    expect(r.state.stack).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it('removes a countered triggered ability without moving its source card', () => {
    const trigger: StackObject = { ...stackObject('s0', 'them0', 1), isTriggered: true };
    const base = board();
    const s: GameState = { ...cloneState(base), stack: [trigger] };
    const r = applyEffect(s, { kind: 'counterSpell' }, 'src', 0, null);

    expect(r.state.stack).toHaveLength(0);
    expect(r.state.cards['them0']!.zone).toBe('battlefield');
    expect(r.events).toEqual([{ type: 'COUNTERED', card: 'them0' }]);
  });
});

// ---------------------------------------------------------------------------
// the loop guard
// ---------------------------------------------------------------------------

describe('the trigger loop guard', () => {
  it('records the TRIGGER event but does not enqueue while a trigger is resolving', () => {
    const s: GameState = { ...withTrigger(board(), 'you0', GAIN_LIFE_TRIGGER), resolvingTrigger: true };
    const r = applyEffect(s, { kind: 'gainLife', player: 'you', amount: 3 }, 'src', 0, null);

    expect(r.state.stack).toHaveLength(0);
    expect(r.events.some((e) => e.type === 'TRIGGER' && e.on === 'onLifeGain')).toBe(true);
    expect(r.state.players[0].life).toBe(STARTING_LIFE + 3);
  });

  it('does not enqueue a trigger that would overflow the stack cap', () => {
    const filled = [0, 1, 2].map((i) => stackObject(`s${i}`, 'other', 1));
    const s: GameState = { ...withTrigger(board(), 'you0', GAIN_LIFE_TRIGGER), stack: filled };
    const r = applyEffect(s, { kind: 'gainLife', player: 'you', amount: 1 }, 'src', 0, null);

    expect(r.state.stack).toHaveLength(STACK_CAP);
    expect(r.events.some((e) => e.type === 'TRIGGER')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// targeting, chaining, immutability
// ---------------------------------------------------------------------------

describe('targeting', () => {
  it("resolves 'self' to the source, whatever the selection says", () => {
    const r = applyEffect(board(), pump(1, 1), 'you0', 0, ['them0']);
    expect(powerOf(r.state, 'you0')).toBe(3);
    expect(powerOf(r.state, 'them0')).toBe(3);
  });

  it('does nothing when a filtered effect was handed no selection', () => {
    const r = applyEffect(board(), { kind: 'destroy', target: ANY_CREATURE }, 'src', 0, null);
    expect(r.state.cards['you0']!.zone).toBe('battlefield');
    expect(r.state.cards['them0']!.zone).toBe('battlefield');
    expect(r.events).toEqual([]);
  });

  it('ignores a selected id that is no longer in the game', () => {
    const r = applyEffect(board(), { kind: 'damage', target: ANY_CREATURE, amount: 2 }, 'src', 0, ['ghost']);
    expect(r.events).toEqual([]);
  });
});

describe('applyEffects', () => {
  it('threads state through the list and accumulates the events in order', () => {
    const { state, id } = putCreature(game(), 0, 'grizzly-bears');
    const r = applyEffects(
      state,
      [
        { kind: 'addCounter', target: 'self', counter: '+1/+1', count: 1 },
        { kind: 'pump', target: 'self', power: 2, toughness: 2, duration: 'endOfTurn' },
        { kind: 'gainLife', player: 'you', amount: 1 },
      ],
      id,
      0,
      null,
    );

    expect(powerOf(r.state, id)).toBe(5);
    expect(r.state.players[0].life).toBe(STARTING_LIFE + 1);
    expect(r.events.map((e) => e.type)).toEqual(['COUNTER_ADD', 'LIFE_CHANGE']);
  });

  it('returns an empty event list for an empty effect list', () => {
    const s = board();
    const r = applyEffects(s, [], 'you0', 0, null);
    expect(r.events).toEqual([]);
    expect(r.state.cards['you0']).toEqual(s.cards['you0']);
  });
});

describe('immutability', () => {
  it('never touches the state handed in', () => {
    const s = board();
    const snapshot = JSON.stringify(s);

    applyEffect(s, { kind: 'damage', target: ANY_CREATURE, amount: 2 }, 'src', 0, ['you0']);
    applyEffect(s, { kind: 'destroy', target: ANY_CREATURE }, 'src', 0, ['them0']);
    applyEffect(s, { kind: 'createToken', token: SOLDIER, count: 1 }, 'src', 0, null);
    applyEffect(s, { kind: 'gainLife', player: 'you', amount: 5 }, 'src', 0, null);
    applyEffects(s, [pump(3, 3), { kind: 'addCounter', target: 'self', counter: '+1/+1', count: 1 }], 'you0', 0, null);

    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('does not share a nested zone array with the state handed in', () => {
    const s = gameWith({ hand: [['a', 'b'], []] });
    const r = applyEffect(s, { kind: 'discard', player: 'you', count: 1 }, 'src', 0, null);

    expect(r.state.players[0].hand).not.toBe(s.players[0].hand);
    expect(s.players[0].hand).toEqual(['a', 'b']);
    expect(s.players[0].graveyard).toEqual([]);
  });

  it('does not share the definition table when a token registers one', () => {
    const s = game();
    const r = applyEffect(s, { kind: 'createToken', token: SOLDIER, count: 1 }, 'src', 0, null);
    expect(Object.keys(s.defs)).toHaveLength(Object.keys(TEST_DEFS).length);
    expect(Object.keys(r.state.defs).length).toBe(Object.keys(s.defs).length + 1);
  });
});
