import { describe, it, expect } from 'vitest';
import {
  createGame,
  cloneState,
  inst,
  def,
  cardsIn,
  move,
  powerOf,
  toughnessOf,
  hasKeyword,
  isCreature,
  opponentOf,
  availableMana,
  canPay,
  payMana,
  newInstance,
} from '../../src/engine/state';
import type { CardDef, GameState } from '../../src/engine/types';
import { STARTING_HAND, STARTING_LIFE } from '../../src/engine/types';
import {
  TEST_DEFS,
  TEST_DECK,
  handOf,
  giveLands,
  putCreature,
  battlefield,
  gameWith,
} from '../fixtures';

const game = () => createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 42);

/** A state whose defs include one extra hand-rolled card, for the static-ability tests. */
function withDef(base: GameState, cardDef: CardDef): GameState {
  return { ...cloneState(base), defs: { ...base.defs, [cardDef.oracleId]: cardDef } };
}

const bears = TEST_DEFS['grizzly-bears']!;

describe('createGame', () => {
  it('deals a seven card opening hand to each player and leaves the rest in the library', () => {
    const s = game();
    expect(s.players[0].hand).toHaveLength(STARTING_HAND);
    expect(s.players[1].hand).toHaveLength(STARTING_HAND);
    expect(s.players[0].library).toHaveLength(TEST_DECK.length - STARTING_HAND);
    expect(s.players[1].library).toHaveLength(TEST_DECK.length - STARTING_HAND);
  });

  it('starts both players at twenty life on turn one in main1, with player 0 on the play', () => {
    const s = game();
    expect(s.players[0].life).toBe(STARTING_LIFE);
    expect(s.players[1].life).toBe(STARTING_LIFE);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('main1');
    expect(s.active).toBe(0);
    expect(s.priority).toBe(0);
    expect(s.stack).toHaveLength(0);
    expect(s.winner).toBeNull();
  });

  it('gives every instance a unique id and registers all of them in state.cards', () => {
    const s = game();
    const ids = Object.keys(s.cards);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(TEST_DECK.length * 2);
    for (const id of [...s.players[0].hand, ...s.players[0].library]) {
      expect(s.cards[id]!.owner).toBe(0);
      expect(s.cards[id]!.id).toBe(id);
    }
    for (const id of s.players[1].hand) expect(s.cards[id]!.owner).toBe(1);
  });

  it('is reproducible from its seed and differs between seeds', () => {
    expect(createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 7).players[0].hand).toEqual(
      createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 7).players[0].hand,
    );
    const oracles = (s: GameState, p: 0 | 1) => handOf(s, p).map((c) => s.cards[c]!.oracleId);
    const a = createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 1);
    const b = createGame(TEST_DEFS, TEST_DECK, TEST_DECK, 2);
    expect(oracles(a, 0)).not.toEqual(oracles(b, 0));
    // Both libraries are shuffled off one stream, so they do not come out identical.
    expect(oracles(a, 0)).not.toEqual(oracles(a, 1));
  });
});

describe('cloneState', () => {
  it('deep copies every nested container so a mutated clone cannot reach the original', () => {
    const s = game();
    const { state: withCreature, id } = putCreature(s, 0, 'grizzly-bears');
    const c = cloneState(withCreature);

    c.players[0].hand.push('intruder');
    c.players[0].manaPool.G = 5;
    c.cards[id]!.counters['+1/+1'] = 3;
    c.cards[id]!.tempPump.power = 9;
    c.cards[id]!.tempKeywords.push('flying');
    c.cards[id]!.blockedBy.push('intruder');
    c.stack.push({ id: 'x', source: id, controller: 0, effects: [], targets: null, isTriggered: false });
    c.players[0].life = 1;

    expect(withCreature.players[0].hand).not.toContain('intruder');
    expect(withCreature.players[0].manaPool.G).toBeUndefined();
    expect(withCreature.cards[id]!.counters['+1/+1']).toBe(0);
    expect(withCreature.cards[id]!.tempPump.power).toBe(0);
    expect(withCreature.cards[id]!.tempKeywords).toHaveLength(0);
    expect(withCreature.cards[id]!.blockedBy).toHaveLength(0);
    expect(withCreature.stack).toHaveLength(0);
    expect(withCreature.players[0].life).toBe(STARTING_LIFE);
  });
});

describe('inst / def / cardsIn', () => {
  it('looks an instance and its definition up by id', () => {
    const s = game();
    const card = handOf(s, 0)[0]!;
    expect(inst(s, card).id).toBe(card);
    expect(def(s, card).oracleId).toBe(inst(s, card).oracleId);
  });

  it('throws loudly on an unknown card rather than returning undefined', () => {
    const s = game();
    expect(() => inst(s, 'nope')).toThrow(/nope/);
    expect(() => def(s, 'nope')).toThrow(/nope/);
  });

  it('reads a zone without handing back the live array', () => {
    const s = game();
    const hand = cardsIn(s, 0, 'hand');
    expect(hand).toEqual(s.players[0].hand);
    hand.push('intruder');
    expect(s.players[0].hand).not.toContain('intruder');
    expect(cardsIn(s, 0, 'battlefield')).toEqual([]);
  });
});

describe('move', () => {
  it('removes from the source zone, appends to the destination, and updates the instance', () => {
    const s = game();
    const card = handOf(s, 0)[0]!;
    const next = move(s, card, 'hand', 'graveyard');
    expect(next.players[0].hand).not.toContain(card);
    expect(next.players[0].graveyard).toEqual([card]);
    expect(next.cards[card]!.zone).toBe('graveyard');
  });

  it('does not mutate the state it was given', () => {
    const s = game();
    const card = handOf(s, 0)[0]!;
    move(s, card, 'hand', 'graveyard');
    expect(s.players[0].hand).toContain(card);
    expect(s.players[0].graveyard).toHaveLength(0);
    expect(s.cards[card]!.zone).toBe('hand');
  });

  it('resets combat and temporary state when a permanent leaves the battlefield', () => {
    const s = battlefield({
      you: [{ power: 2, toughness: 2, tapped: true, damage: 1, tempPump: { power: 3, toughness: 3 } }],
      them: [{ power: 1, toughness: 1 }],
    });
    const attacking = cloneState(s);
    attacking.cards['you0']!.attacking = true;
    attacking.cards['you0']!.blockedBy = ['them0'];
    attacking.cards['you0']!.counters['+1/+1'] = 2;
    attacking.cards['you0']!.tempKeywords = ['flying'];

    const dead = move(attacking, 'you0', 'battlefield', 'graveyard');
    const c = dead.cards['you0']!;
    expect(c.tapped).toBe(false);
    expect(c.damage).toBe(0);
    expect(c.attacking).toBe(false);
    expect(c.blockedBy).toEqual([]);
    expect(c.counters).toEqual({ '+1/+1': 0, '-1/-1': 0 });
    expect(c.tempPump).toEqual({ power: 0, toughness: 0 });
    expect(c.tempKeywords).toEqual([]);
    expect(dead.players[0].graveyard).toEqual(['you0']);
  });

  it('deletes a token outright when it leaves the battlefield', () => {
    const s = battlefield({ you: [{ power: 1, toughness: 1 }], them: [] });
    const withToken = cloneState(s);
    withToken.cards['you0']!.isToken = true;

    const gone = move(withToken, 'you0', 'battlefield', 'graveyard');
    expect(gone.cards['you0']).toBeUndefined();
    expect(gone.players[0].graveyard).toEqual([]);
    expect(gone.players[0].battlefield).toEqual([]);
  });

  it('throws when the card is not in the zone it was said to be in', () => {
    const s = game();
    const card = handOf(s, 0)[0]!;
    expect(() => move(s, card, 'graveyard', 'exile')).toThrow();
    expect(() => move(s, 'nope', 'hand', 'graveyard')).toThrow(/nope/);
  });
});

describe('powerOf / toughnessOf', () => {
  it('sums base, counters and temporary pump', () => {
    const s = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const pumped = cloneState(s);
    pumped.cards['you0']!.counters['+1/+1'] = 2;
    pumped.cards['you0']!.counters['-1/-1'] = 1;
    pumped.cards['you0']!.tempPump = { power: 3, toughness: 3 };
    expect(powerOf(pumped, 'you0')).toBe(2 + 2 - 1 + 3);
    expect(toughnessOf(pumped, 'you0')).toBe(2 + 2 - 1 + 3);
  });

  it('stacks two pumps rather than replacing one with the other', () => {
    const s = battlefield({ you: [{ power: 2, toughness: 2, tempPump: { power: 3, toughness: 3 } }], them: [] });
    const twice = cloneState(s);
    twice.cards['you0']!.tempPump = { power: 6, toughness: 6 };
    expect(powerOf(twice, 'you0')).toBe(8);
  });

  it('is zero for a permanent with no base power, such as a land', () => {
    let s: GameState = game();
    s = giveLands(s, 0, 'G', 1);
    const land = s.players[0].battlefield[0]!;
    expect(powerOf(s, land)).toBe(0);
    expect(toughnessOf(s, land)).toBe(0);
    expect(isCreature(s, land)).toBe(false);
  });

  it('adds a staticPump from another permanent but respects excludeSelf', () => {
    const lord: CardDef = {
      ...bears,
      oracleId: 'test-lord',
      name: 'Test Lord',
      statics: [
        {
          kind: 'staticPump',
          filter: { zone: 'battlefield', controller: 'you', cardTypes: ['creature'] },
          power: 1,
          toughness: 1,
          excludeSelf: true,
        },
      ],
    };
    let s = withDef(gameWith({}), lord);
    s = newInstance(s, 'test-lord', 0, 'battlefield').state;
    const mine = putCreature(s, 0, 'grizzly-bears');
    const theirs = putCreature(mine.state, 1, 'grizzly-bears');
    const final = theirs.state;
    const lordId = final.players[0].battlefield[0]!;

    expect(powerOf(final, mine.id)).toBe(3);
    expect(toughnessOf(final, mine.id)).toBe(3);
    expect(powerOf(final, lordId)).toBe(2);
    expect(powerOf(final, theirs.id)).toBe(2);
  });

  it('adds the power an attached aura grants its host', () => {
    const aura: CardDef = {
      ...bears,
      oracleId: 'test-aura',
      name: 'Test Aura',
      cardTypes: ['enchantment'],
      subtypes: ['Aura'],
      power: undefined,
      toughness: undefined,
      keywords: [],
      statics: [
        {
          kind: 'aura',
          attachTo: { zone: 'battlefield', cardTypes: ['creature'] },
          power: 2,
          toughness: 2,
          keywords: ['flying'],
        },
      ],
    };
    let s = withDef(gameWith({}), aura);
    const host = putCreature(s, 0, 'grizzly-bears');
    const enchant = newInstance(host.state, 'test-aura', 0, 'battlefield');
    s = cloneState(enchant.state);
    s.cards[enchant.id]!.attachedTo = host.id;

    expect(powerOf(s, host.id)).toBe(4);
    expect(toughnessOf(s, host.id)).toBe(4);
    expect(hasKeyword(s, host.id, 'flying')).toBe(true);
  });
});

describe('hasKeyword', () => {
  it('reads the definition keywords', () => {
    const s = putCreature(gameWith({}), 0, 'serra-angel');
    expect(hasKeyword(s.state, s.id, 'flying')).toBe(true);
    expect(hasKeyword(s.state, s.id, 'vigilance')).toBe(true);
    expect(hasKeyword(s.state, s.id, 'trample')).toBe(false);
  });

  it('reads a keyword granted by a static ability', () => {
    const flyer: CardDef = {
      ...bears,
      oracleId: 'test-static-flyer',
      name: 'Test Static Flyer',
      keywords: [],
      statics: [{ kind: 'keyword', keyword: 'flying' }],
    };
    let s = withDef(gameWith({}), flyer);
    const made = newInstance(s, 'test-static-flyer', 0, 'battlefield');
    s = made.state;
    expect(hasKeyword(s, made.id, 'flying')).toBe(true);
    expect(hasKeyword(s, made.id, 'menace')).toBe(false);
  });

  it('reads a temporary keyword granted this turn', () => {
    const made = putCreature(gameWith({}), 0, 'grizzly-bears');
    const s = cloneState(made.state);
    s.cards[made.id]!.tempKeywords = ['haste'];
    expect(hasKeyword(s, made.id, 'haste')).toBe(true);
  });
});

describe('isCreature / opponentOf', () => {
  it('recognises a creature and rejects an instant', () => {
    const creature = putCreature(gameWith({}), 0, 'grizzly-bears');
    expect(isCreature(creature.state, creature.id)).toBe(true);
    const bolt = newInstance(gameWith({}), 'lightning-bolt', 0, 'hand');
    expect(isCreature(bolt.state, bolt.id)).toBe(false);
  });

  it('flips the player id', () => {
    expect(opponentOf(0)).toBe(1);
    expect(opponentOf(1)).toBe(0);
  });
});

describe('mana', () => {
  it('counts untapped lands and floating mana, and ignores tapped lands', () => {
    let s = giveLands(gameWith({}), 0, 'G', 3);
    s = giveLands(s, 0, 'W', 1);
    const tappedOne = cloneState(s);
    tappedOne.cards[tappedOne.players[0].battlefield[0]!]!.tapped = true;
    tappedOne.players[0].manaPool = { R: 1, C: 1 };

    expect(availableMana(s, 0)).toEqual({ G: 3, W: 1 });
    expect(availableMana(tappedOne, 0)).toEqual({ G: 2, W: 1, R: 1, C: 1 });
    expect(availableMana(s, 1)).toEqual({});
  });

  it('pays a generic cost with an off-color land', () => {
    let s = giveLands(gameWith({}), 0, 'G', 1);
    s = giveLands(s, 0, 'W', 1);
    // Grizzly Bears is {1}{G}: the Plains pays the generic, the Forest pays the green.
    expect(canPay(s, 0, { G: 1, C: 1 })).toBe(true);
    expect(canPay(s, 0, { C: 2 })).toBe(true);
    expect(canPay(s, 0, { W: 1, C: 1 })).toBe(true);
    // Two green pips is beyond a lone Forest no matter how the Plains is spent.
    expect(canPay(s, 0, { G: 2 })).toBe(false);
    expect(canPay(s, 0, { C: 3 })).toBe(false);
    expect(canPay(s, 0, { G: 1, C: 2 })).toBe(false);
  });

  it('pays a generic cost from colorless floating mana but never a colored pip', () => {
    const s = cloneState(gameWith({}));
    s.players[0].manaPool = { C: 2 };
    expect(canPay(s, 0, { C: 2 })).toBe(true);
    expect(canPay(s, 0, { G: 1, C: 1 })).toBe(false);
  });

  it('an empty cost is always payable', () => {
    expect(canPay(gameWith({}), 0, {})).toBe(true);
  });

  it('payMana spends floating mana first, then taps exactly the lands it needs', () => {
    let s = giveLands(gameWith({}), 0, 'G', 2);
    s = giveLands(s, 0, 'W', 1);
    const withFloat = cloneState(s);
    withFloat.players[0].manaPool = { G: 1 };

    const paid = payMana(withFloat, 0, { G: 1, C: 1 });
    expect(paid.players[0].manaPool.G ?? 0).toBe(0);
    const tapped = paid.players[0].battlefield.filter((c) => paid.cards[c]!.tapped);
    expect(tapped).toHaveLength(1);
    expect(availableMana(paid, 0)).toEqual({ G: 1, W: 1 });
  });

  it('payMana leaves the input state untouched and throws when the cost cannot be paid', () => {
    const s = giveLands(gameWith({}), 0, 'G', 2);
    payMana(s, 0, { G: 1 });
    expect(s.players[0].battlefield.every((c) => !s.cards[c]!.tapped)).toBe(true);
    expect(() => payMana(s, 0, { W: 1 })).toThrow();
  });
});

describe('newInstance', () => {
  it('creates a uniquely identified card in the requested zone without touching the input', () => {
    const s = gameWith({});
    const first = newInstance(s, 'grizzly-bears', 0, 'battlefield');
    const second = newInstance(first.state, 'grizzly-bears', 0, 'battlefield');
    expect(first.id).not.toBe(second.id);
    expect(second.state.nextId).toBeGreaterThan(s.nextId);
    expect(second.state.players[0].battlefield).toEqual([first.id, second.id]);
    expect(second.state.cards[first.id]!.zone).toBe('battlefield');
    expect(second.state.cards[first.id]!.controller).toBe(0);
    expect(s.players[0].battlefield).toEqual([]);
    expect(s.cards[first.id]).toBeUndefined();
  });

  it('puts a card into the hand of the player it was made for', () => {
    const inHand = newInstance(gameWith({}), 'lightning-bolt', 1, 'hand');
    expect(inHand.state.players[1].hand).toEqual([inHand.id]);
    expect(inHand.state.cards[inHand.id]!.owner).toBe(1);
  });
});

describe('fixtures', () => {
  it('battlefield() builds both boards in the declare attackers step', () => {
    const s = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['flying'] }, { power: 1, toughness: 1, tapped: true }],
      them: [{ power: 3, toughness: 3, summonedThisTurn: true }],
    });
    expect(s.phase).toBe('declareAttackers');
    expect(s.active).toBe(0);
    expect(s.priority).toBe(0);
    expect(s.players[0].battlefield).toEqual(['you0', 'you1']);
    expect(s.players[1].battlefield).toEqual(['them0']);
    expect(powerOf(s, 'you0')).toBe(2);
    expect(toughnessOf(s, 'them0')).toBe(3);
    expect(hasKeyword(s, 'you0', 'flying')).toBe(true);
    expect(s.cards['you1']!.tapped).toBe(true);
    expect(s.cards['them0']!.summonedThisTurn).toBe(true);
    expect(s.cards['them0']!.controller).toBe(1);
    expect(isCreature(s, 'them0')).toBe(true);
  });

  it('gameWith() applies its overrides and materialises the ids it is handed', () => {
    const s = gameWith({
      life: [3, 17],
      hand: [['a', 'b'], []],
      library: [[], ['c']],
      phase: 'draw',
      active: 1,
    });
    expect(s.players[0].life).toBe(3);
    expect(s.players[1].life).toBe(17);
    expect(s.players[0].hand).toEqual(['a', 'b']);
    expect(s.players[1].library).toEqual(['c']);
    expect(s.phase).toBe('draw');
    expect(s.active).toBe(1);
    expect(s.priority).toBe(1);
    expect(inst(s, 'a').zone).toBe('hand');
    expect(inst(s, 'c').zone).toBe('library');
    expect(inst(s, 'c').owner).toBe(1);
  });

  it('TEST_DECK is sixty cards and every one of them is defined', () => {
    expect(TEST_DECK).toHaveLength(60);
    for (const oracleId of TEST_DECK) expect(TEST_DEFS[oracleId]).toBeDefined();
  });
});
