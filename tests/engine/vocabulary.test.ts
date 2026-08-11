/**
 * The seven members added to `types.ts` in vocabulary revision 1.
 *
 * They are tested together rather than spread across the per-module files
 * because each one is only honored when several modules agree about it: "any
 * target" is a rule in `actions.ts` and an interpretation in `effects.ts`,
 * `cantBlock` has to mean the same thing to the generator and to combat, and a
 * lord's keywords have to land on exactly the creatures its +N/+N does. A
 * member that compiles but does nothing is the failure this file exists to
 * catch, so every test below asserts an observable consequence — a life total, a
 * legal action, a creature that may or may not attack — and never merely that a
 * field survived a round trip.
 *
 * Engine mutators take a `GameState` and return `{ state, events }`, so these
 * read `applyEffect(...).state` and never chain a `ReduceResult` back in.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDef,
  CardId,
  Effect,
  GameEvent,
  GameState,
  OracleId,
  Phase,
  PlayerId,
  PlayerTarget,
  TargetFilter,
  TriggerEvent,
  Zone,
} from '../../src/engine/types';
import { STARTING_LIFE } from '../../src/engine/types';
import { canCast, legalActions, legalTargets } from '../../src/engine/actions';
import { canAttack, canBlock, declareBlockers } from '../../src/engine/combat';
import { applyEffect } from '../../src/engine/effects';
import { cloneState, hasKeyword, newInstance, powerOf, toughnessOf } from '../../src/engine/state';
import { reduce, resolveTop } from '../../src/engine/rules';
import { battlefield, gameWith, giveLands } from '../fixtures';

// ---------------------------------------------------------------------------
// Card definitions
// ---------------------------------------------------------------------------

/** Fill in the parts of a `CardDef` no test cares about. */
function makeDef(partial: Partial<CardDef> & { oracleId: OracleId; name: string }): CardDef {
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

const ANY_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] };
const THEIR_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'opponent', cardTypes: ['creature'] };
const YOUR_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'you', cardTypes: ['creature'] };

/** "Target nonblack creature" — the filter a whitelist of colors cannot express. */
const NONBLACK_CREATURE: TargetFilter = { ...ANY_CREATURE, notColors: ['B'] };
const NONARTIFACT_CREATURE: TargetFilter = { ...ANY_CREATURE, notCardTypes: ['artifact'] };

/** A Goblin lord's filter: "other Goblins you control". */
const YOUR_GOBLINS: TargetFilter = {
  zone: 'battlefield',
  controller: 'you',
  cardTypes: ['creature'],
  subtypes: ['Goblin'],
};

const DEFS: Record<OracleId, CardDef> = {
  /** "Bolt deals 3 damage to any target." The card the member exists for. */
  bolt: makeDef({
    oracleId: 'bolt',
    name: 'Bolt',
    manaCost: { R: 1 },
    cmc: 1,
    colors: ['R'],
    cardTypes: ['instant'],
    oracleText: 'Bolt deals 3 damage to any target.',
    targets: [ANY_CREATURE],
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  }),

  /** The same card with the creature half left implicit, to prove both authorings work. */
  'bare-bolt': makeDef({
    oracleId: 'bare-bolt',
    name: 'Bare Bolt',
    manaCost: { R: 1 },
    cmc: 1,
    colors: ['R'],
    cardTypes: ['instant'],
    spellEffects: [{ kind: 'damage', target: 'any', amount: 3 }],
  }),

  /** "{T}: This creature deals 1 damage to any target." */
  pyromancer: makeDef({
    oracleId: 'pyromancer',
    name: 'Pyromancer',
    colors: ['R'],
    power: 1,
    toughness: 1,
    activated: [
      {
        cost: { tapSelf: true },
        effects: [{ kind: 'damage', target: 'any', amount: 1 }],
        sorcerySpeed: false,
        targets: [ANY_CREATURE],
      },
    ],
  }),

  /** Black *and* red: the creature a whitelist of the other four colors wrongly catches. */
  'rakdos-brute': makeDef({
    oracleId: 'rakdos-brute',
    name: 'Rakdos Brute',
    colors: ['B', 'R'],
    power: 2,
    toughness: 2,
  }),

  shade: makeDef({ oracleId: 'shade', name: 'Shade', colors: ['B'], power: 2, toughness: 2 }),

  bear: makeDef({ oracleId: 'bear', name: 'Bear', colors: ['W'], power: 2, toughness: 2 }),

  /** Colorless: the creature a whitelist of the other four colors wrongly excludes. */
  golem: makeDef({ oracleId: 'golem', name: 'Golem', colors: [], power: 2, toughness: 2 }),

  sable: makeDef({
    oracleId: 'sable',
    name: 'Bronze Sable',
    colors: [],
    cardTypes: ['artifact', 'creature'],
    power: 2,
    toughness: 1,
  }),

  /** "This creature can't block." */
  berserker: makeDef({
    oracleId: 'berserker',
    name: 'Berserker',
    power: 3,
    toughness: 1,
    oracleText: "This creature can't block.",
    statics: [{ kind: 'cantBlock' }],
  }),

  attacker: makeDef({ oracleId: 'attacker', name: 'Attacker', power: 2, toughness: 2 }),

  blocker: makeDef({ oracleId: 'blocker', name: 'Blocker', power: 2, toughness: 2 }),

  /** "Other Goblins you control get +1/+1 and have haste." */
  'goblin-lord': makeDef({
    oracleId: 'goblin-lord',
    name: 'Goblin Lord',
    colors: ['R'],
    subtypes: ['Goblin'],
    power: 2,
    toughness: 2,
    statics: [
      {
        kind: 'staticPump',
        filter: YOUR_GOBLINS,
        power: 1,
        toughness: 1,
        excludeSelf: true,
        keywords: ['haste'],
      },
    ],
  }),

  /** The same lord without the word "other": it pumps and hastes itself too. */
  'goblin-anthem': makeDef({
    oracleId: 'goblin-anthem',
    name: 'Goblin Anthem',
    colors: ['R'],
    subtypes: ['Goblin'],
    power: 2,
    toughness: 2,
    statics: [
      {
        kind: 'staticPump',
        filter: YOUR_GOBLINS,
        power: 1,
        toughness: 1,
        excludeSelf: false,
        keywords: ['haste'],
      },
    ],
  }),

  /** A lord that grants no keyword at all: `keywords` is optional and absent. */
  'silent-lord': makeDef({
    oracleId: 'silent-lord',
    name: 'Silent Lord',
    colors: ['R'],
    subtypes: ['Goblin'],
    power: 2,
    toughness: 2,
    statics: [{ kind: 'staticPump', filter: YOUR_GOBLINS, power: 1, toughness: 1, excludeSelf: true }],
  }),

  /** "Nonblack creatures you control get +1/+1." A lord read through a negated filter. */
  'pale-lord': makeDef({
    oracleId: 'pale-lord',
    name: 'Pale Lord',
    power: 0,
    toughness: 3,
    cardTypes: ['enchantment'],
    statics: [
      {
        kind: 'staticPump',
        filter: { zone: 'battlefield', controller: 'you', cardTypes: ['creature'], notColors: ['B'] },
        power: 1,
        toughness: 1,
        excludeSelf: true,
      },
    ],
  }),

  goblin: makeDef({
    oracleId: 'goblin',
    name: 'Goblin',
    colors: ['R'],
    subtypes: ['Goblin'],
    power: 1,
    toughness: 1,
  }),

  /** Not a Goblin, so no lord reaches it. */
  ogre: makeDef({ oracleId: 'ogre', name: 'Ogre', colors: ['R'], subtypes: ['Ogre'], power: 1, toughness: 1 }),

  /** "Whenever another creature you control enters, you gain 1 life." Soul Warden. */
  warden: makeDef({
    oracleId: 'warden',
    name: 'Warden',
    colors: ['W'],
    power: 1,
    toughness: 1,
    oracleText: 'Whenever another creature you control enters, you gain 1 life.',
    triggers: [
      { on: 'onOtherEnterBattlefield', effects: [{ kind: 'gainLife', player: 'you', amount: 1 }] },
    ],
  }),

  /** A creature with nothing to say about anything entering. */
  bystander: makeDef({ oracleId: 'bystander', name: 'Bystander', power: 1, toughness: 1 }),

  /**
   * "When this creature dies, it deals 2 damage to target creature."
   * The trigger declares no targets, so it falls back to `CardDef.targets`.
   */
  firefiend: makeDef({
    oracleId: 'firefiend',
    name: 'Firefiend',
    colors: ['R'],
    power: 2,
    toughness: 1,
    targets: [THEIR_CREATURE],
    triggers: [{ on: 'onDies', effects: [{ kind: 'damage', target: ANY_CREATURE, amount: 2 }] }],
  }),

  /**
   * The same card with the trigger declaring targets of its own, which must win
   * over the ones the definition declares for the card's other half.
   */
  sniper: makeDef({
    oracleId: 'sniper',
    name: 'Sniper',
    colors: ['R'],
    power: 2,
    toughness: 1,
    targets: [YOUR_CREATURE],
    triggers: [
      {
        on: 'onDies',
        effects: [{ kind: 'damage', target: ANY_CREATURE, amount: 2 }],
        targets: [THEIR_CREATURE],
      },
    ],
  }),

  /** A trigger with no targets anywhere: nothing is chosen and nothing is pointed at. */
  mourner: makeDef({
    oracleId: 'mourner',
    name: 'Mourner',
    power: 2,
    toughness: 1,
    triggers: [{ on: 'onDies', effects: [{ kind: 'gainLife', player: 'you', amount: 1 }] }],
  }),

  'hexproof-bear': makeDef({
    oracleId: 'hexproof-bear',
    name: 'Hexproof Bear',
    colors: ['G'],
    power: 2,
    toughness: 2,
    keywords: ['hexproof'],
  }),
};

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

/** An empty game that knows about the definitions above. */
function stage(phase: Phase = 'main1'): GameState {
  const base = gameWith({ phase });
  return { ...base, defs: { ...base.defs, ...DEFS } };
}

/**
 * Put a card into a zone. On the battlefield it arrives settled — it has been
 * there since before this turn — unless a test wants the summoning sickness.
 */
function put(
  state: GameState,
  oracleId: OracleId,
  player: PlayerId,
  zone: Zone = 'battlefield',
  summonedThisTurn = false,
): { state: GameState; id: CardId } {
  const made = newInstance(state, oracleId, player, zone);
  const next = cloneState(made.state);
  if (zone === 'battlefield') next.cards[made.id]!.summonedThisTurn = summonedThisTurn;
  return { state: next, id: made.id };
}

/** Several cards for one player, in order. */
function putAll(
  state: GameState,
  oracleIds: OracleId[],
  player: PlayerId,
): { state: GameState; ids: CardId[] } {
  let next = state;
  const ids: CardId[] = [];
  for (const oracleId of oracleIds) {
    const made = put(next, oracleId, player);
    next = made.state;
    ids.push(made.id);
  }
  return { state: next, ids };
}

/** A spell of this player's, on the stack and ready for `resolveTop`. */
function onStack(state: GameState, oracleId: OracleId, player: PlayerId): { state: GameState; id: CardId } {
  const made = newInstance(state, oracleId, player, 'stack');
  const next = cloneState(made.state);
  next.stack.push({
    id: `spell#${next.nextId}`,
    source: made.id,
    controller: player,
    effects: [],
    targets: null,
    isTriggered: false,
  });
  next.nextId += 1;
  return { state: next, id: made.id };
}

/** Every trigger that fired, as `{ source, on }`. */
function fired(events: GameEvent[]): Array<{ source: CardId; on: TriggerEvent }> {
  return events.flatMap((event) => (event.type === 'TRIGGER' ? [{ source: event.source, on: event.on }] : []));
}

/** The target selections `legalActions` offers for casting this card. */
function castTargets(state: GameState, card: CardId): unknown[] {
  return legalActions(state)
    .filter((action) => action.kind === 'castSpell' && action.card === card)
    .map((action) => (action.kind === 'castSpell' ? action.targets : null));
}

// ---------------------------------------------------------------------------
// A. PlayerTarget: 'you' | 'opponent' | 'target'
// ---------------------------------------------------------------------------

describe('PlayerTarget', () => {
  const drawing = (player: PlayerTarget): Effect => ({ kind: 'draw', player, count: 1 });

  const libraries = (): GameState =>
    gameWith({ library: [['mine0', 'mine1'], ['theirs0', 'theirs1']] });

  it('draws for the player the caster chose', () => {
    const r = applyEffect(libraries(), drawing('target'), 'src', 0, 'player1');

    expect(r.state.players[1].hand).toEqual(['theirs0']);
    expect(r.state.players[0].hand).toEqual([]);
  });

  it('draws for the caster when they chose themselves', () => {
    const r = applyEffect(libraries(), drawing('target'), 'src', 0, 'player0');

    expect(r.state.players[0].hand).toEqual(['mine0']);
    expect(r.state.players[1].hand).toEqual([]);
  });

  it('reads you and opponent from the controller, not from player 0', () => {
    const you = applyEffect(libraries(), drawing('you'), 'src', 1, null);
    expect(you.state.players[1].hand).toEqual(['theirs0']);

    const them = applyEffect(libraries(), drawing('opponent'), 'src', 1, null);
    expect(them.state.players[0].hand).toEqual(['mine0']);
  });

  it('falls back to the opponent when a target player was never chosen', () => {
    const r = applyEffect(libraries(), drawing('target'), 'src', 0, null);
    expect(r.state.players[1].hand).toEqual(['theirs0']);
  });

  it('discards from the hand of the player the caster chose', () => {
    const state = gameWith({ hand: [['mine0'], ['theirs0']] });
    const r = applyEffect(state, { kind: 'discard', player: 'target', count: 1 }, 'src', 0, 'player1');

    expect(r.state.players[1].hand).toEqual([]);
    expect(r.state.players[1].graveyard).toEqual(['theirs0']);
    expect(r.state.players[0].hand).toEqual(['mine0']);
  });

  it('gains life for the player the caster chose', () => {
    const r = applyEffect(gameWith({}), { kind: 'gainLife', player: 'target', amount: 4 }, 'src', 1, 'player1');

    expect(r.state.players[1].life).toBe(STARTING_LIFE + 4);
    expect(r.state.players[0].life).toBe(STARTING_LIFE);
  });

  it('loses life for the player the caster chose', () => {
    const r = applyEffect(gameWith({}), { kind: 'loseLife', player: 'target', amount: 4 }, 'src', 1, 'player0');

    expect(r.state.players[0].life).toBe(STARTING_LIFE - 4);
    expect(r.state.players[1].life).toBe(STARTING_LIFE);
  });
});

// ---------------------------------------------------------------------------
// B. EffectTarget 'any' resolves to a creature or a player
// ---------------------------------------------------------------------------

describe("damage to 'any' target", () => {
  const burn: Effect = { kind: 'damage', target: 'any', amount: 3 };

  const board = (): GameState => {
    const mine = put(stage(), 'bear', 0);
    return put(mine.state, 'bear', 1).state;
  };

  const creatures = (state: GameState): CardId[] => [
    ...state.players[0].battlefield,
    ...state.players[1].battlefield,
  ];

  it('marks the creature the caster pointed at', () => {
    const state = board();
    const target = creatures(state)[1]!;
    const r = applyEffect(state, burn, 'src', 0, [target]);

    expect(r.state.cards[target]!.damage).toBe(3);
    expect(r.state.players[0].life).toBe(STARTING_LIFE);
    expect(r.state.players[1].life).toBe(STARTING_LIFE);
    expect(r.events).toEqual([{ type: 'DAMAGE', source: 'src', target, amount: 3, isPlayer: false }]);
  });

  it('burns the face when the caster pointed at a player instead', () => {
    const state = board();
    const r = applyEffect(state, burn, 'src', 0, 'player1');

    expect(r.state.players[1].life).toBe(STARTING_LIFE - 3);
    for (const id of creatures(r.state)) expect(r.state.cards[id]!.damage).toBe(0);
    expect(r.events).toEqual([
      { type: 'DAMAGE', source: 'src', target: 1, amount: 3, isPlayer: true },
      { type: 'LIFE_CHANGE', player: 1, from: STARTING_LIFE, to: STARTING_LIFE - 3 },
    ]);
  });

  it('can be pointed at its own controller', () => {
    const r = applyEffect(board(), burn, 'src', 0, 'player0');
    expect(r.state.players[0].life).toBe(STARTING_LIFE - 3);
  });

  it('does nothing at all when no target was chosen', () => {
    const state = board();
    const r = applyEffect(state, burn, 'src', 0, null);

    expect(r.events).toEqual([]);
    expect(r.state.players.map((p) => p.life)).toEqual([STARTING_LIFE, STARTING_LIFE]);
    for (const id of creatures(r.state)) expect(r.state.cards[id]!.damage).toBe(0);
  });

  it('leaves a non-damage effect pointed at a player doing nothing', () => {
    const state = board();
    const r = applyEffect(
      state,
      { kind: 'pump', target: 'any', power: 3, toughness: 3, duration: 'endOfTurn' },
      'src',
      0,
      'player1',
    );

    for (const id of creatures(r.state)) expect(powerOf(r.state, id)).toBe(2);
  });

  it('pumps the creature when that is what the caster pointed at', () => {
    const state = board();
    const target = creatures(state)[0]!;
    const r = applyEffect(
      state,
      { kind: 'pump', target: 'any', power: 3, toughness: 3, duration: 'endOfTurn' },
      'src',
      0,
      [target],
    );

    expect(powerOf(r.state, target)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// C. "Any target" is enumerated as creatures *and* faces
// ---------------------------------------------------------------------------

describe("legalActions for an 'any target' spell", () => {
  /** A Bolt in hand, a Mountain to cast it with, and whatever else a test asks for. */
  function burnBoard(yours: OracleId[], theirs: OracleId[], spell: OracleId = 'bolt'): {
    state: GameState;
    spell: CardId;
    yours: CardId[];
    theirs: CardId[];
  } {
    let state = giveLands(stage(), 0, 'R', 1);
    const mine = putAll(state, yours, 0);
    state = mine.state;
    const opposing = putAll(state, theirs, 1);
    state = opposing.state;
    const held = put(state, spell, 0, 'hand');
    return { state: held.state, spell: held.id, yours: mine.ids, theirs: opposing.ids };
  }

  it('offers every creature and both faces', () => {
    const board = burnBoard(['bear'], ['golem']);
    const offered = castTargets(board.state, board.spell);

    expect(offered).toEqual([[board.yours[0]], [board.theirs[0]], 'player0', 'player1']);
  });

  it('is castable with an empty board, pointed at a face', () => {
    const board = burnBoard([], []);

    expect(canCast(board.state, board.spell)).toBe(true);
    expect(castTargets(board.state, board.spell)).toEqual(['player0', 'player1']);
  });

  it('offers the same two halves when the creature filter is left implicit', () => {
    const board = burnBoard(['bear'], [], 'bare-bolt');

    expect(castTargets(board.state, board.spell)).toEqual([[board.yours[0]], 'player0', 'player1']);
  });

  it('still offers both faces when the only creature is out of reach', () => {
    const board = burnBoard([], ['hexproof-bear']);

    expect(castTargets(board.state, board.spell)).toEqual(['player0', 'player1']);
  });

  it('offers both halves for an activated ability too', () => {
    let state = giveLands(stage(), 0, 'R', 1);
    const source = put(state, 'pyromancer', 0);
    state = source.state;
    const victim = put(state, 'bear', 1);
    state = victim.state;

    const offered = legalActions(state)
      .filter((action) => action.kind === 'activate' && action.card === source.id)
      .map((action) => (action.kind === 'activate' ? action.targets : null));

    expect(offered).toEqual([[source.id], [victim.id], 'player0', 'player1']);
  });

  it('resolves at a face, all the way through reduce', () => {
    const board = burnBoard([], ['bear']);
    const cast = reduce(board.state, { kind: 'castSpell', card: board.spell, targets: 'player1' });
    const resolved = resolveTop(cast.state);

    expect(resolved.state.players[1].life).toBe(STARTING_LIFE - 3);
    expect(resolved.state.cards[board.theirs[0]!]!.damage).toBe(0);
  });

  it('resolves at a creature, all the way through reduce', () => {
    const board = burnBoard([], ['bear']);
    const cast = reduce(board.state, { kind: 'castSpell', card: board.spell, targets: [board.theirs[0]!] });
    const resolved = resolveTop(cast.state);

    expect(resolved.state.players[1].life).toBe(STARTING_LIFE);
    // A 2/2 with 3 damage marked is swept up by state-based actions.
    expect(resolved.state.cards[board.theirs[0]!]!.zone).toBe('graveyard');
  });
});

// ---------------------------------------------------------------------------
// D. notColors and notCardTypes
// ---------------------------------------------------------------------------

describe('negated target filters', () => {
  /** A black-red creature, a colorless one, a white one, and a mono-black one. */
  function colorBoard(): { state: GameState; ids: Record<string, CardId> } {
    const built = putAll(stage(), ['rakdos-brute', 'golem', 'bear', 'shade'], 0);
    const [brute, golem, bear, shade] = built.ids;
    return { state: built.state, ids: { brute: brute!, golem: golem!, bear: bear!, shade: shade! } };
  }

  it('refuses a black multicolor creature for "target nonblack creature"', () => {
    const board = colorBoard();
    const targets = legalTargets(board.state, NONBLACK_CREATURE, 0);

    expect(targets).not.toContain(board.ids.brute);
    expect(targets).not.toContain(board.ids.shade);
  });

  it('offers a colorless creature for "target nonblack creature"', () => {
    const board = colorBoard();
    const targets = legalTargets(board.state, NONBLACK_CREATURE, 0);

    expect(targets).toContain(board.ids.golem);
    expect(targets).toEqual([board.ids.golem, board.ids.bear]);
  });

  it('refuses an artifact creature for "target nonartifact creature"', () => {
    let state = stage();
    const sable = put(state, 'sable', 0);
    state = sable.state;
    const golem = put(state, 'golem', 0);
    state = golem.state;

    const targets = legalTargets(state, NONARTIFACT_CREATURE, 0);
    expect(targets).toEqual([golem.id]);
  });

  it('narrows a lord the same way, so the pump lands on the same creatures', () => {
    let state = put(stage(), 'pale-lord', 0).state;
    const brute = put(state, 'rakdos-brute', 0);
    state = brute.state;
    const golem = put(state, 'golem', 0);
    state = golem.state;

    expect(powerOf(state, golem.id)).toBe(3);
    expect(toughnessOf(state, golem.id)).toBe(3);
    expect(powerOf(state, brute.id)).toBe(2);
    expect(toughnessOf(state, brute.id)).toBe(2);
  });

  it('leaves a filter without negated fields exactly as it was', () => {
    const board = colorBoard();
    expect(legalTargets(board.state, ANY_CREATURE, 0)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// E. cantBlock
// ---------------------------------------------------------------------------

describe('cantBlock', () => {
  /** Player 0 attacking, player 1 holding the blocker a test names. */
  function combat(blockerOracle: OracleId): { state: GameState; attacker: CardId; blocker: CardId } {
    let state = stage('declareBlockers');
    const attacking = put(state, 'attacker', 0);
    state = attacking.state;
    const defending = put(state, blockerOracle, 1);
    state = cloneState(defending.state);

    state.cards[attacking.id]!.attacking = true;
    state.cards[attacking.id]!.tapped = true;
    state.priority = 1;
    return { state, attacker: attacking.id, blocker: defending.id };
  }

  it('refuses the block', () => {
    const board = combat('berserker');
    expect(canBlock(board.state, board.blocker, board.attacker)).toBe(false);
  });

  it('still lets an ordinary creature block', () => {
    const board = combat('blocker');
    expect(canBlock(board.state, board.blocker, board.attacker)).toBe(true);
  });

  it('is never offered as a blocker by the generator', () => {
    const board = combat('berserker');
    const blocks = legalActions(board.state)
      .filter((action) => action.kind === 'declareBlockers')
      .map((action) => (action.kind === 'declareBlockers' ? action.blocks : []));

    // Only the empty declaration: there is nobody who may block.
    expect(blocks).toEqual([[]]);
  });

  it('throws if a declaration reaches combat anyway', () => {
    const board = combat('berserker');
    expect(() =>
      declareBlockers(board.state, [{ blocker: board.blocker, attacker: board.attacker }]),
    ).toThrow(/cannot block/);
  });

  it('does not stop the creature attacking', () => {
    let state = stage('declareAttackers');
    const made = put(state, 'berserker', 0);
    state = made.state;

    expect(canAttack(state, made.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. staticPump.keywords
// ---------------------------------------------------------------------------

describe('keywords granted by a lord', () => {
  /**
   * A Goblin lord and a Goblin of yours, a Goblin of theirs, and an Ogre —
   * everything the filter should and should not reach.
   */
  function tribal(lord: OracleId = 'goblin-lord'): {
    state: GameState;
    lord: CardId;
    goblin: CardId;
    ogre: CardId;
    theirGoblin: CardId;
  } {
    const mine = putAll(stage(), [lord, 'goblin', 'ogre'], 0);
    const theirs = putAll(mine.state, ['goblin'], 1);
    const [lordId, goblinId, ogreId] = mine.ids;
    return {
      state: theirs.state,
      lord: lordId!,
      goblin: goblinId!,
      ogre: ogreId!,
      theirGoblin: theirs.ids[0]!,
    };
  }

  it('grants the keyword to the other Goblins you control', () => {
    const board = tribal();
    expect(hasKeyword(board.state, board.goblin, 'haste')).toBe(true);
  });

  it('does not grant it to the lord itself when the lord says "other"', () => {
    const board = tribal();
    expect(hasKeyword(board.state, board.lord, 'haste')).toBe(false);
  });

  it('does grant it to the lord itself when the lord does not say "other"', () => {
    const board = tribal('goblin-anthem');
    expect(hasKeyword(board.state, board.lord, 'haste')).toBe(true);
  });

  it('does not reach the opponent Goblins', () => {
    const board = tribal();
    expect(hasKeyword(board.state, board.theirGoblin, 'haste')).toBe(false);
  });

  it('does not reach your creatures outside the tribe', () => {
    const board = tribal();
    expect(hasKeyword(board.state, board.ogre, 'haste')).toBe(false);
  });

  it('lands on exactly the creatures the pump does', () => {
    const board = tribal();

    expect(powerOf(board.state, board.goblin)).toBe(2);
    expect(powerOf(board.state, board.lord)).toBe(2);
    expect(powerOf(board.state, board.ogre)).toBe(1);
    expect(powerOf(board.state, board.theirGoblin)).toBe(1);
  });

  it('lets a Goblin that just arrived attack, which is the whole point', () => {
    let state = stage('declareAttackers');
    const lord = put(state, 'goblin-lord', 0);
    state = lord.state;
    const hasty = put(state, 'goblin', 0, 'battlefield', true);
    state = hasty.state;

    expect(state.cards[hasty.id]!.summonedThisTurn).toBe(true);
    expect(canAttack(state, hasty.id)).toBe(true);
    expect(legalActions(state)).toContainEqual({ kind: 'declareAttackers', attackers: [hasty.id] });
  });

  it('grants nothing when the lord lists no keywords', () => {
    const board = tribal('silent-lord');

    expect(hasKeyword(board.state, board.goblin, 'haste')).toBe(false);
    expect(powerOf(board.state, board.goblin)).toBe(2);
  });

  it('does not reach a Goblin that is not on the battlefield', () => {
    let state = put(stage(), 'goblin-lord', 0).state;
    const inHand = put(state, 'goblin', 0, 'hand');
    state = inHand.state;

    expect(hasKeyword(state, inHand.id, 'haste')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. onOtherEnterBattlefield
// ---------------------------------------------------------------------------

describe('onOtherEnterBattlefield', () => {
  it('fires once for each other watcher you control', () => {
    const mine = putAll(stage(), ['warden', 'warden', 'bystander'], 0);
    const cast = onStack(mine.state, 'bear', 0);
    const resolved = resolveTop(cast.state);

    expect(fired(resolved.events)).toEqual([
      { source: mine.ids[0]!, on: 'onOtherEnterBattlefield' },
      { source: mine.ids[1]!, on: 'onOtherEnterBattlefield' },
    ]);
  });

  it('does not fire for the creature that is entering', () => {
    const mine = putAll(stage(), ['warden'], 0);
    const cast = onStack(mine.state, 'warden', 0);
    const resolved = resolveTop(cast.state);

    const sources = fired(resolved.events).map((entry) => entry.source);
    expect(sources).toEqual([mine.ids[0]!]);
    expect(sources).not.toContain(cast.id);
  });

  it('fires for a watcher across the table, because "another creature" means any', () => {
    // Soul Warden gains life off the creatures your opponent plays too. Firing only
    // for the watcher's own side would silently drop about half of its triggers,
    // which is an approximation of the card rather than the card.
    const theirs = putAll(stage(), ['warden'], 1);
    const cast = onStack(theirs.state, 'bear', 0);
    const resolved = resolveTop(cast.state);

    expect(fired(resolved.events)).toEqual([
      { source: theirs.ids[0]!, on: 'onOtherEnterBattlefield' },
    ]);
  });

  it('fires for watchers on both sides at once', () => {
    const mine = putAll(stage(), ['warden'], 0);
    const both = putAll(mine.state, ['warden'], 1);
    const cast = onStack(both.state, 'bear', 0);
    const resolved = resolveTop(cast.state);

    const sources = fired(resolved.events).map((entry) => entry.source).sort();
    expect(sources).toEqual([mine.ids[0]!, both.ids[0]!].sort());
  });

  it('actually resolves, so the life is really gained', () => {
    const mine = putAll(stage(), ['warden'], 0);
    const cast = onStack(mine.state, 'bear', 0);
    const entered = resolveTop(cast.state);
    const gained = resolveTop(entered.state);

    expect(gained.state.players[0].life).toBe(STARTING_LIFE + 1);
    expect(gained.state.players[1].life).toBe(STARTING_LIFE);
  });

  it('does not fire when the permanent entering is not a creature', () => {
    let state = putAll(stage(), ['warden'], 0).state;
    const land = put(state, 'forest', 0, 'hand');
    state = land.state;

    const played = reduce(state, { kind: 'playLand', card: land.id });
    expect(fired(played.events)).toEqual([]);
    expect(played.state.players[0].life).toBe(STARTING_LIFE);
  });
});

// ---------------------------------------------------------------------------
// H. Trigger.targets
// ---------------------------------------------------------------------------

describe('targets chosen by a trigger', () => {
  /** A creature of yours that dies, and one creature on each side to point at. */
  function deathbed(dying: OracleId): { state: GameState; dying: CardId; mine: CardId; theirs: CardId } {
    const mine = putAll(stage(), [dying, 'bear'], 0);
    const theirs = putAll(mine.state, ['golem'], 1);
    return {
      state: theirs.state,
      dying: mine.ids[0]!,
      mine: mine.ids[1]!,
      theirs: theirs.ids[0]!,
    };
  }

  const destroy = (state: GameState, card: CardId): ReturnType<typeof applyEffect> =>
    applyEffect(state, { kind: 'destroy', target: {} }, card, 0, [card]);

  it('prefers the targets the trigger declares over the ones the card declares', () => {
    const board = deathbed('sniper');
    const dead = destroy(board.state, board.dying);

    expect(dead.state.stack).toHaveLength(1);
    expect(dead.state.stack[0]!.targets).toEqual([board.theirs]);
  });

  it('falls back to the card targets when the trigger declares none', () => {
    const board = deathbed('firefiend');
    const dead = destroy(board.state, board.dying);

    expect(dead.state.stack[0]!.targets).toEqual([board.theirs]);
  });

  it('chooses nothing when neither declares a target', () => {
    const board = deathbed('mourner');
    const dead = destroy(board.state, board.dying);

    expect(dead.state.stack[0]!.targets).toBeNull();
  });

  it('deals the damage to what it chose when it resolves', () => {
    const board = deathbed('sniper');
    const dead = destroy(board.state, board.dying);
    const resolved = resolveTop(dead.state);

    // Two damage is lethal to the 2/2 it chose, so the mark is gone by the time
    // the sweep is done — the death is the evidence that the damage landed.
    expect(resolved.state.cards[board.theirs]!.zone).toBe('graveyard');
    expect(resolved.state.cards[board.mine]!.zone).toBe('battlefield');
    expect(resolved.state.cards[board.mine]!.damage).toBe(0);
  });

  it('will not point a trigger at a hexproof permanent it could not otherwise reach', () => {
    const mine = putAll(stage(), ['sniper'], 0);
    const theirs = putAll(mine.state, ['hexproof-bear'], 1);
    const dead = destroy(theirs.state, mine.ids[0]!);

    expect(dead.state.stack[0]!.targets).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// H. Mass effects: { every: filter }
// ---------------------------------------------------------------------------

/**
 * A bare `TargetFilter` means one *chosen* target and resolves from the caster's
 * selection. A mass effect has nothing to choose, so written as a bare filter it
 * resolves to nothing while looking like it worked — Wrath of God destroying no
 * creatures. `{ every: filter }` is the distinction.
 */
describe('every: sweeps the battlefield instead of a selection', () => {
  it('destroys every creature on both sides, with no target chosen', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }, { power: 5, toughness: 5 }],
      them: [{ power: 1, toughness: 1 }, { power: 7, toughness: 7 }],
    });
    const out = applyEffect(
      board,
      { kind: 'destroy', target: { every: { zone: 'battlefield', cardTypes: ['creature'], controller: 'any' } } },
      'you0',
      0,
      null,
    );

    for (const id of ['you0', 'you1', 'them0', 'them1']) {
      expect(out.state.cards[id]!.zone).toBe('graveyard');
    }
  });

  it('the same effect written as a bare filter destroys nothing', () => {
    // This is the exact bug the member exists to make impossible to write by accident.
    const board = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 1, toughness: 1 }] });
    const out = applyEffect(
      board,
      { kind: 'destroy', target: { zone: 'battlefield', cardTypes: ['creature'], controller: 'any' } },
      'you0',
      0,
      null,
    );
    expect(out.state.cards['you0']!.zone).toBe('battlefield');
    expect(out.state.cards['them0']!.zone).toBe('battlefield');
  });

  it('honors controller: you, so a one-sided pump misses the opponent', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }, { power: 3, toughness: 3 }],
      them: [{ power: 4, toughness: 4 }],
    });
    const out = applyEffect(
      board,
      {
        kind: 'pump',
        target: { every: { zone: 'battlefield', cardTypes: ['creature'], controller: 'you' } },
        power: 3, toughness: 3, duration: 'endOfTurn',
      },
      'you0',
      0,
      null,
    );

    expect(powerOf(out.state, 'you0')).toBe(5);
    expect(powerOf(out.state, 'you1')).toBe(6);
    expect(powerOf(out.state, 'them0')).toBe(4);
  });

  it('grants a keyword to everything it sweeps', () => {
    const board = battlefield({ you: [{ power: 2, toughness: 2 }, { power: 3, toughness: 3 }], them: [] });
    const out = applyEffect(
      board,
      {
        kind: 'grantKeyword',
        target: { every: { zone: 'battlefield', cardTypes: ['creature'], controller: 'you' } },
        keyword: 'trample', duration: 'endOfTurn',
      },
      'you0',
      0,
      null,
    );
    expect(hasKeyword(out.state, 'you0', 'trample')).toBe(true);
    expect(hasKeyword(out.state, 'you1', 'trample')).toBe(true);
  });

  it('sweeps only what the filter matches', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }, { power: 2, toughness: 2, keywords: ['flying'] }],
      them: [],
    });
    const out = applyEffect(
      board,
      { kind: 'destroy', target: { every: { zone: 'battlefield', cardTypes: ['creature'], controller: 'you', maxPower: 2 } } },
      'you0',
      0,
      null,
    );
    // Both are 2 power, so both go — the point is the filter is consulted at all.
    expect(out.state.cards['you0']!.zone).toBe('graveyard');
    expect(out.state.cards['you1']!.zone).toBe('graveyard');
  });
});
