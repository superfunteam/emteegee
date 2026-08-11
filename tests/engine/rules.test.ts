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
  CardInstance,
  Effect,
  GameState,
  Phase,
  StackObject,
  TargetFilter,
  TargetSelection,
} from '../../src/engine/types';
import { PHASE_ORDER } from '../../src/engine/types';
import { cloneState, newInstance, powerOf } from '../../src/engine/state';
import { advancePhase, reduce, resolveTop, stateBasedActions } from '../../src/engine/rules';
import { battlefield, gameWith, giveLands, putCreature } from '../fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = { kind: 'pass' } as const;

/** The filter an effect uses when the selection has already been decided. */
const SELECTED: TargetFilter = {};

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
function tweak(state: GameState, card: CardId, patch: (instance: CardInstance) => void): GameState {
  const next = cloneState(state);
  patch(next.cards[card]!);
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

const ANY_CREATURE: TargetFilter = {
  zone: 'battlefield',
  cardTypes: ['creature'],
  controller: 'any',
};

/** "Enchant creature. Enchanted creature gets +1/+1." */
const AURA_DEF: CardDef = makeDef({
  oracleId: 'test-aura',
  name: 'Test Aura',
  manaCost: { W: 1 },
  cmc: 1,
  colors: ['W'],
  cardTypes: ['enchantment'],
  subtypes: ['Aura'],
  oracleText: 'Enchanted creature gets +1/+1.',
  statics: [{ kind: 'aura', attachTo: ANY_CREATURE, power: 1, toughness: 1, keywords: [] }],
  targets: [ANY_CREATURE],
});

/** "When this creature enters the battlefield, you gain 3 life." */
const WELCOMER_DEF: CardDef = makeDef({
  oracleId: 'test-welcomer',
  name: 'Test Welcomer',
  manaCost: { W: 1 },
  cmc: 1,
  colors: ['W'],
  power: 1,
  toughness: 1,
  triggers: [{ on: 'onEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 3 }] }],
});

/** "{T}: Add {G}." */
const DORK_DEF: CardDef = makeDef({
  oracleId: 'test-dork',
  name: 'Test Dork',
  manaCost: { G: 1 },
  cmc: 1,
  colors: ['G'],
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: { tapSelf: true },
      effects: [{ kind: 'addMana', colors: ['G'] }],
      sorcerySpeed: false,
      targets: [],
    },
  ],
});

/** "Whenever another creature you control enters, you gain 1 life." (Soul Warden.) */
const WARDEN_DEF: CardDef = makeDef({
  oracleId: 'test-warden',
  name: 'Test Warden',
  manaCost: { W: 1 },
  cmc: 1,
  colors: ['W'],
  power: 1,
  toughness: 1,
  triggers: [
    { on: 'onOtherEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 1 }] },
  ],
});

/** "At the beginning of your upkeep, you lose 1 life." */
const HAUNT_DEF: CardDef = makeDef({
  oracleId: 'test-haunt',
  name: 'Test Haunt',
  manaCost: { B: 1 },
  cmc: 1,
  colors: ['B'],
  power: 1,
  toughness: 1,
  triggers: [{ on: 'onUpkeep', effects: [{ kind: 'loseLife', player: 'you', amount: 1 }] }],
});

/** "Whenever this creature attacks, it gets +1/+0 until end of turn." */
const RAIDER_DEF: CardDef = makeDef({
  oracleId: 'test-raider',
  name: 'Test Raider',
  manaCost: { R: 1 },
  cmc: 1,
  colors: ['R'],
  power: 2,
  toughness: 2,
  triggers: [
    {
      on: 'onAttack',
      effects: [{ kind: 'pump', target: 'self', power: 1, toughness: 0, duration: 'endOfTurn' }],
    },
  ],
});

/** The same game, with one more card definition registered. */
function register(state: GameState, definition: CardDef): GameState {
  const next = cloneState(state);
  next.defs = { ...next.defs, [definition.oracleId]: definition };
  return next;
}

/** An aura on player 0's battlefield, already attached to `host`. */
function withAura(state: GameState, host: CardId): { state: GameState; id: CardId } {
  const made = newInstance(register(state, AURA_DEF), AURA_DEF.oracleId, 0, 'battlefield');
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

  it('throws rather than spinning when a sweep cannot settle', () => {
    // A corrupt state: the instance claims to be in the graveyard while the
    // battlefield array still holds it, so destroying it changes nothing and
    // the sweep would repeat forever. Spec §13: an engine bug is loud.
    const board = battlefield({ you: [{ power: 1, toughness: 1, damage: 1 }], them: [] });
    const state = tweak(board, 'you0', (card) => {
      card.zone = 'graveyard';
    });

    expect(() => stateBasedActions(state)).toThrow(/engine bug/i);
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

  it('stops for the defender to block, then settles the trade', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] });

    const attacked = reduce(state, { kind: 'declareAttackers', attackers: ['you0'] });
    expect(attacked.state.phase).toBe('declareBlockers');
    expect(attacked.state.priority).toBe(1);

    const blocked = reduce(attacked.state, {
      kind: 'declareBlockers',
      blocks: [{ blocker: 'them0', attacker: 'you0' }],
    });

    expect(blocked.state.cards['you0']!.zone).toBe('graveyard');
    expect(blocked.state.cards['them0']!.zone).toBe('graveyard');
    expect(blocked.state.players[1].life).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Spells, abilities, and triggers
// ---------------------------------------------------------------------------

describe('resolution', () => {
  it('fires enter-the-battlefield triggers and holds the phase until they resolve', () => {
    let state = giveLands(register(gameWith({}), WELCOMER_DEF), 0, 'W', 1);
    const made = newInstance(state, WELCOMER_DEF.oracleId, 0, 'hand');
    state = made.state;

    const entered = reduce(
      reduce(state, { kind: 'castSpell', card: made.id, targets: null }).state,
      PASS,
    );

    expect(entered.state.cards[made.id]!.zone).toBe('battlefield');
    expect(entered.events.some((e) => e.type === 'TRIGGER' && e.on === 'onEnterBattlefield')).toBe(true);
    // The trigger is waiting, so the phase has not moved on without it.
    expect(entered.state.stack).toHaveLength(1);
    expect(entered.state.phase).toBe('main1');

    const resolved = reduce(entered.state, PASS);
    expect(resolved.state.players[0].life).toBe(23);
    expect(resolved.state.stack).toEqual([]);
  });

  it('attaches an aura to the target chosen when it was cast', () => {
    let state = giveLands(register(gameWith({}), AURA_DEF), 0, 'W', 1);
    const host = putCreature(state, 0, 'grizzly-bears');
    state = host.state;
    const made = newInstance(state, AURA_DEF.oracleId, 0, 'hand');
    state = made.state;

    const cast = reduce(state, { kind: 'castSpell', card: made.id, targets: [host.id] });
    const resolved = reduce(cast.state, PASS);

    expect(resolved.state.cards[made.id]!.zone).toBe('battlefield');
    expect(resolved.state.cards[made.id]!.attachedTo).toBe(host.id);
    expect(powerOf(resolved.state, host.id)).toBe(3);
  });

  it('lets the permanents already out notice another creature arriving', () => {
    let state = register(gameWith({}), WARDEN_DEF);
    const warden = putCreature(state, 0, WARDEN_DEF.oracleId);
    state = giveLands(warden.state, 0, 'G', 2);
    const made = newInstance(state, 'grizzly-bears', 0, 'hand');
    state = made.state;

    const entered = reduce(
      reduce(state, { kind: 'castSpell', card: made.id, targets: null }).state,
      PASS,
    );

    // The warden notices; the creature that arrived does not notice itself.
    const noticed = entered.events.filter(
      (e) => e.type === 'TRIGGER' && e.on === 'onOtherEnterBattlefield',
    );
    expect(noticed).toHaveLength(1);
    expect(noticed[0]).toMatchObject({ source: warden.id });

    expect(reduce(entered.state, PASS).state.players[0].life).toBe(21);
  });

  it('stops at upkeep rather than racing past a trigger it just put on the stack', () => {
    const state = register(gameWith({}), HAUNT_DEF);
    const haunt = putCreature(state, 0, HAUNT_DEF.oracleId);

    const upkeep = reduce(atPhase(haunt.state, 'untap'), PASS);
    expect(upkeep.state.phase).toBe('upkeep');
    expect(upkeep.state.stack).toHaveLength(1);
    expect(upkeep.events.some((e) => e.type === 'TRIGGER' && e.on === 'onUpkeep')).toBe(true);

    const resolved = reduce(upkeep.state, PASS);
    expect(resolved.state.players[0].life).toBe(19);
    expect(resolved.state.phase).toBe('upkeep');
  });

  it('resolves an attack trigger before blockers are declared', () => {
    const state = register(gameWith({}), RAIDER_DEF);
    const raider = putCreature(state, 0, RAIDER_DEF.oracleId);

    const attacked = reduce(atPhase(raider.state, 'declareAttackers'), {
      kind: 'declareAttackers',
      attackers: [raider.id],
    });
    expect(attacked.state.phase).toBe('declareBlockers');
    expect(attacked.state.stack).toHaveLength(1);

    // One pass resolves the trigger; the phase holds, because a resolution is
    // its own priority window. The next pass carries combat forward.
    const pumped = reduce(attacked.state, PASS);
    expect(powerOf(pumped.state, raider.id)).toBe(3);
    expect(pumped.state.phase).toBe('declareBlockers');
    expect(pumped.state.stack).toEqual([]);

    const swung = reduce(pumped.state, PASS);
    expect(swung.state.players[1].life).toBe(17);
  });

  it('resolves a mana ability without using the stack', () => {
    const state = register(gameWith({}), DORK_DEF);
    const dork = putCreature(state, 0, DORK_DEF.oracleId);

    const result = reduce(dork.state, {
      kind: 'activate',
      card: dork.id,
      abilityIndex: 0,
      targets: null,
    });

    expect(result.state.stack).toEqual([]);
    expect(result.state.players[0].manaPool.G).toBe(1);
    expect(result.state.cards[dork.id]!.tapped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The loop guard, at the state-based-action boundary
// ---------------------------------------------------------------------------

/**
 * Regression: the guard used to be cleared before state-based actions ran.
 *
 * That gap mattered because a trigger never kills anything directly — damage only
 * marks, and the state-based sweep is what destroys the creature and fires its
 * `onDies`. With the flag already cleared, the sweep ran unguarded and a trigger
 * could enqueue a trigger through the back door, which is precisely the loop the
 * flag exists to make structurally impossible.
 */
describe('a trigger may not enqueue a trigger, including through state-based actions', () => {
  function boardWithDyingTrigger(): { state: GameState; victim: CardId; source: CardId } {
    let state = gameWith({ phase: 'main1' });

    const DIES_LOUDLY: CardDef = {
      ...state.defs['grizzly-bears']!,
      oracleId: 'dies-loudly',
      name: 'Dies Loudly',
      power: 1,
      toughness: 1,
      triggers: [{ on: 'onDies', effects: [{ kind: 'draw', player: 'you', count: 1 }] }],
    };
    state = { ...state, defs: { ...state.defs, 'dies-loudly': DIES_LOUDLY } };

    const madeVictim = newInstance(state, 'dies-loudly', 1, 'battlefield');
    state = madeVictim.state;
    const madeSource = newInstance(state, 'grizzly-bears', 0, 'battlefield');
    state = cloneState(madeSource.state);

    return { state, victim: madeVictim.id, source: madeSource.id };
  }

  it('does not stack the onDies of a creature killed by a resolving trigger', () => {
    const { state, victim, source } = boardWithDyingTrigger();
    const next = cloneState(state);

    // A triggered ability that deals lethal damage to the victim.
    next.stack.push({
      id: 'trigger#1',
      source,
      controller: 0,
      effects: [{ kind: 'damage', target: { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] }, amount: 5 }],
      targets: [victim],
      isTriggered: true,
    });

    const out = resolveTop(next);

    expect(out.state.cards[victim]!.zone).toBe('graveyard');
    expect(out.events.some((e) => e.type === 'DIE' && e.card === victim)).toBe(true);
    // The death is recorded, but its trigger does not go on the stack.
    expect(out.state.stack).toHaveLength(0);
    expect(out.state.resolvingTrigger).toBe(false);
  });

  it('still stacks that same onDies when a spell, not a trigger, does the killing', () => {
    const { state, victim, source } = boardWithDyingTrigger();
    const next = cloneState(state);

    next.stack.push({
      id: 'spell#1',
      source,
      controller: 0,
      effects: [{ kind: 'damage', target: { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] }, amount: 5 }],
      targets: [victim],
      isTriggered: false,
    });

    const out = resolveTop(next);

    expect(out.state.cards[victim]!.zone).toBe('graveyard');
    expect(out.state.stack.length).toBeGreaterThan(0);
    expect(out.state.stack[0]!.isTriggered).toBe(true);
  });

  it('leaves the guard clear once resolution finishes either way', () => {
    const { state, victim, source } = boardWithDyingTrigger();
    const next = cloneState(state);
    next.stack.push({
      id: 'trigger#2', source, controller: 0,
      effects: [{ kind: 'gainLife', player: 'you', amount: 1 }],
      targets: null, isTriggered: true,
    });
    expect(resolveTop(next).state.resolvingTrigger).toBe(false);
    expect(victim).toBeDefined();
  });
});
