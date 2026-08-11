import { describe, it, expect } from 'vitest';
import { KEYWORD_VALUE, evaluate } from '../../src/bot/evaluate';
import { cloneState, newInstance } from '../../src/engine/state';
import type { CardDef, GameState, PlayerId } from '../../src/engine/types';
import { ALL_KEYWORDS } from '../../src/engine/types';
import { battlefield, gameWith, giveLands } from '../fixtures';

/** An empty board, both players at twenty, nothing in hand. Scores zero for either side. */
const empty = (): GameState => battlefield({ you: [], them: [] });

/** A lord, so the tests can check that `evaluate` sees a buff it did not print. */
const LORD: CardDef = {
  oracleId: 'test-lord',
  name: 'Test Lord',
  manaCost: { C: 2 },
  cmc: 2,
  colors: [],
  cardTypes: ['creature'],
  subtypes: ['Test'],
  power: 1,
  toughness: 1,
  oracleText: 'Other creatures you control get +1/+1 and have flying.',
  keywords: [],
  statics: [
    {
      kind: 'staticPump',
      filter: { zone: 'battlefield', controller: 'you', cardTypes: ['creature'] },
      power: 1,
      toughness: 1,
      excludeSelf: true,
      keywords: ['flying'],
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

function addLord(base: GameState, player: PlayerId): GameState {
  const withDef: GameState = { ...cloneState(base), defs: { ...base.defs, [LORD.oracleId]: LORD } };
  return newInstance(withDef, LORD.oracleId, player, 'battlefield').state;
}

/** Set `+1/+1` counters on a card without reaching into the state a test shares. */
function withCounters(base: GameState, card: string, count: number): GameState {
  const next = cloneState(base);
  next.cards[card]!.counters['+1/+1'] = count;
  return next;
}

describe('KEYWORD_VALUE', () => {
  it('prices every keyword in the contract', () => {
    for (const keyword of ALL_KEYWORDS) {
      expect(KEYWORD_VALUE[keyword], keyword).toBeTypeOf('number');
      expect(Number.isFinite(KEYWORD_VALUE[keyword]), keyword).toBe(true);
    }
    expect(Object.keys(KEYWORD_VALUE)).toHaveLength(ALL_KEYWORDS.length);
  });

  it('scores evasion and damage multipliers above defensive keywords', () => {
    const defensive = Math.max(
      KEYWORD_VALUE['first strike'],
      KEYWORD_VALUE.lifelink,
      KEYWORD_VALUE.ward,
      KEYWORD_VALUE.vigilance,
      KEYWORD_VALUE.reach,
      KEYWORD_VALUE.haste,
      KEYWORD_VALUE.flash,
    );
    for (const keyword of ['flying', 'menace', 'trample', 'double strike', 'deathtouch'] as const) {
      expect(KEYWORD_VALUE[keyword], keyword).toBeGreaterThan(defensive);
    }
  });

  it('scores defender negative, because a wall does not advance the race', () => {
    expect(KEYWORD_VALUE.defender).toBeLessThan(0);
  });
});

describe('evaluate: the formula', () => {
  it('scores an empty, even board at zero for both players', () => {
    expect(evaluate(empty(), 0)).toBe(0);
    expect(evaluate(empty(), 1)).toBe(0);
  });

  it('weights the life differential at two per point', () => {
    const s = gameWith({ life: [20, 15] });
    expect(evaluate(s, 0)).toBe(10);
    expect(evaluate(s, 1)).toBe(-10);
  });

  it('counts power plus toughness for my creatures and against theirs', () => {
    expect(evaluate(battlefield({ you: [{ power: 2, toughness: 3 }], them: [] }), 0)).toBe(5);
    expect(evaluate(battlefield({ you: [], them: [{ power: 2, toughness: 3 }] }), 0)).toBe(-5);
  });

  it('values a card in hand at 1.5, and does not price the opponent unknown hand', () => {
    const s = gameWith({ hand: [['a', 'b', 'c'], ['x']] });
    expect(evaluate(s, 0)).toBe(4.5);
    expect(evaluate(s, 1)).toBe(1.5);
  });

  it('values an untapped land at 0.5 and a tapped one at nothing', () => {
    const three = giveLands(gameWith({}), 0, 'G', 3);
    expect(evaluate(three, 0)).toBe(1.5);
    expect(evaluate(three, 1)).toBe(0);

    const tapped = cloneState(three);
    tapped.cards[three.players[0].battlefield[0]!]!.tapped = true;
    expect(evaluate(tapped, 0)).toBe(1);
  });

  it('adds keyword value on top of stats', () => {
    const vanilla = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const angel = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['flying', 'vigilance'] }],
      them: [],
    });
    expect(evaluate(angel, 0)).toBe(
      evaluate(vanilla, 0) + KEYWORD_VALUE.flying + KEYWORD_VALUE.vigilance,
    );
  });
});

describe('evaluate: board strength', () => {
  it('scores a bigger board higher', () => {
    const small = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const big = battlefield({ you: [{ power: 5, toughness: 5 }], them: [] });
    expect(evaluate(big, 0)).toBeGreaterThan(evaluate(small, 0));
  });

  it('scores more creatures higher than fewer', () => {
    const one = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const two = battlefield({
      you: [
        { power: 2, toughness: 2 },
        { power: 2, toughness: 2 },
      ],
      them: [],
    });
    expect(evaluate(two, 0)).toBeGreaterThan(evaluate(one, 0));
  });

  it('scores their board against me exactly as mine counts for me', () => {
    const mine = battlefield({ you: [{ power: 3, toughness: 4, keywords: ['trample'] }], them: [] });
    const theirs = battlefield({ you: [], them: [{ power: 3, toughness: 4, keywords: ['trample'] }] });
    expect(evaluate(mine, 0)).toBe(-evaluate(theirs, 0));
  });

  it('ignores non-creature permanents when summing stats', () => {
    const lands = giveLands(gameWith({}), 0, 'G', 2);
    // Two untapped Forests are worth 1.0 in mana and nothing in power or toughness.
    expect(evaluate(lands, 0)).toBe(1);
  });
});

describe('evaluate: keywords change how a creature is priced', () => {
  it('scores a flier above a vanilla creature of the same size', () => {
    const vanilla = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const flier = battlefield({ you: [{ power: 2, toughness: 2, keywords: ['flying'] }], them: [] });
    expect(evaluate(flier, 0)).toBeGreaterThan(evaluate(vanilla, 0));
  });

  it('scores a defender below a vanilla creature of the same size', () => {
    const vanilla = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const wall = battlefield({ you: [{ power: 2, toughness: 2, keywords: ['defender'] }], them: [] });
    expect(evaluate(wall, 0)).toBeLessThan(evaluate(vanilla, 0));
  });

  it('prefers the opponent to have the defender and me to have the flier', () => {
    const good = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
      them: [{ power: 2, toughness: 2, keywords: ['defender'] }],
    });
    const bad = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['defender'] }],
      them: [{ power: 2, toughness: 2, keywords: ['flying'] }],
    });
    expect(evaluate(good, 0)).toBeGreaterThan(evaluate(bad, 0));
  });
});

describe('evaluate: terminal states', () => {
  it('is +Infinity when the opponent is dead', () => {
    expect(evaluate(gameWith({ life: [3, 0] }), 0)).toBe(Infinity);
    expect(evaluate(gameWith({ life: [3, -7] }), 0)).toBe(Infinity);
  });

  it('is -Infinity when I am dead', () => {
    expect(evaluate(gameWith({ life: [0, 3] }), 0)).toBe(-Infinity);
    expect(evaluate(gameWith({ life: [-7, 3] }), 0)).toBe(-Infinity);
  });

  it('lets no board or hand advantage outweigh being dead', () => {
    const s = cloneState(
      battlefield({ you: [{ power: 12, toughness: 12, keywords: ['flying'] }], them: [] }),
    );
    s.players[0].life = 0;
    expect(evaluate(s, 0)).toBe(-Infinity);
    expect(evaluate(s, 1)).toBe(Infinity);
  });

  it('reads a decided game off state.winner, so decking out scores as a win', () => {
    const s = cloneState(gameWith({ life: [4, 4] }));
    s.winner = 1;
    expect(evaluate(s, 1)).toBe(Infinity);
    expect(evaluate(s, 0)).toBe(-Infinity);
  });
});

describe('evaluate: symmetry', () => {
  it('moves in opposite directions for the two players when a board improves', () => {
    const before = battlefield({
      you: [{ power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2 }],
    });
    const after = battlefield({
      you: [{ power: 5, toughness: 5, keywords: ['flying'] }],
      them: [{ power: 2, toughness: 2 }],
    });

    expect(evaluate(after, 0)).toBeGreaterThan(evaluate(before, 0));
    expect(evaluate(after, 1)).toBeLessThan(evaluate(before, 1));
    // The board terms are exactly antisymmetric: what I gain, they lose.
    expect(evaluate(after, 0) - evaluate(before, 0)).toBe(
      -(evaluate(after, 1) - evaluate(before, 1)),
    );
  });

  it('moves in opposite directions when life changes', () => {
    const before = gameWith({ life: [20, 20] });
    const after = gameWith({ life: [20, 12] });
    expect(evaluate(after, 0)).toBeGreaterThan(evaluate(before, 0));
    expect(evaluate(after, 1)).toBeLessThan(evaluate(before, 1));
  });

  it('scores a mirrored board at zero from both sides', () => {
    const mirror = battlefield({
      you: [{ power: 3, toughness: 3, keywords: ['deathtouch'] }],
      them: [{ power: 3, toughness: 3, keywords: ['deathtouch'] }],
    });
    expect(evaluate(mirror, 0)).toBe(0);
    expect(evaluate(mirror, 1)).toBe(0);
  });
});

describe('evaluate: live characteristics, not printed ones', () => {
  it('sees temporary pump', () => {
    const plain = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const pumped = battlefield({
      you: [{ power: 2, toughness: 2, tempPump: { power: 3, toughness: 3 } }],
      them: [],
    });
    expect(evaluate(pumped, 0)).toBe(evaluate(plain, 0) + 6);
  });

  it('sees +1/+1 counters', () => {
    const plain = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    expect(evaluate(withCounters(plain, 'you0', 2), 0)).toBe(evaluate(plain, 0) + 4);
  });

  it('sees a lord buffing the rest of my board, and the keyword it grants', () => {
    const plain = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    // The lord is a 1/1 that does not pump itself: +2 for its own stats, +2 for
    // the +1/+1 on the bear, and the flying it hands out.
    expect(evaluate(addLord(plain, 0), 0)).toBe(evaluate(plain, 0) + 2 + 2 + KEYWORD_VALUE.flying);
  });

  it('sees a lord buffing the opponent board and scores it against me', () => {
    const plain = battlefield({ you: [], them: [{ power: 2, toughness: 2 }] });
    expect(evaluate(addLord(plain, 1), 0)).toBe(evaluate(plain, 0) - 2 - 2 - KEYWORD_VALUE.flying);
  });

  it('sees a keyword granted until end of turn', () => {
    const plain = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const granted = cloneState(plain);
    granted.cards['you0']!.tempKeywords = ['trample'];
    expect(evaluate(granted, 0)).toBe(evaluate(plain, 0) + KEYWORD_VALUE.trample);
  });
});

describe('evaluate: purity', () => {
  it('does not touch the state it is given', () => {
    const s = giveLands(
      battlefield({
        you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
        them: [{ power: 4, toughness: 4 }],
      }),
      0,
      'G',
      2,
    );
    const snapshot = JSON.stringify(s);
    evaluate(s, 0);
    evaluate(s, 1);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('returns the same number every time for the same position', () => {
    const s = battlefield({
      you: [{ power: 3, toughness: 3, keywords: ['lifelink'] }],
      them: [{ power: 1, toughness: 5, keywords: ['defender'] }],
    });
    expect(evaluate(s, 0)).toBe(evaluate(s, 0));
    expect(evaluate(s, 1)).toBe(evaluate(s, 1));
  });
});
