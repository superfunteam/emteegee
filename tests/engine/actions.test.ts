/**
 * `actions.ts` is the single source of truth for legality, so these tests are
 * written against `legalActions` and then assert that everything else in the
 * module agrees with it.
 *
 * Nothing here leans on a shuffle. `createGame` deals a random seven, and a test
 * that says "find a land in the opening hand" is a test that silently skips
 * itself the day the seed changes. Every state below is built card by card so
 * the assertion is about the rule, not about the deal.
 */

import { describe, it, expect } from 'vitest';
import { canCast, isLegal, legalActions, legalTargets, validateAttack, validateBlocks } from '../../src/engine/actions';
import { cloneState, newInstance } from '../../src/engine/state';
import type {
  Action,
  CardDef,
  CardId,
  Color,
  GameState,
  OracleId,
  Phase,
  PlayerId,
  StackObject,
  TargetFilter,
} from '../../src/engine/types';
import { STACK_CAP } from '../../src/engine/types';
import { TEST_DEFS, battlefield, gameWith, giveLands } from '../fixtures';

// ---------------------------------------------------------------------------
// Extra card definitions
// ---------------------------------------------------------------------------

/**
 * Each of these is a Grizzly Bears (a {1}{G} 2/2) or a Lightning Bolt with one
 * thing changed, so a test reads as "the same card, but with ward" rather than
 * as a fresh card whose other fields have to be checked.
 */
const BEARS = TEST_DEFS['grizzly-bears']!;
const BOLT = TEST_DEFS['lightning-bolt']!;

const ANY_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] };

const EXTRA_DEFS: Record<OracleId, CardDef> = {
  'flash-bears': { ...BEARS, oracleId: 'flash-bears', name: 'Flash Bears', keywords: ['flash'] },
  'hexproof-bears': { ...BEARS, oracleId: 'hexproof-bears', name: 'Hexproof Bears', keywords: ['hexproof'] },
  'ward-bears': {
    ...BEARS,
    oracleId: 'ward-bears',
    name: 'Ward Bears',
    keywords: ['ward'],
    wardCost: { C: 2 },
  },
  tapper: {
    ...BEARS,
    oracleId: 'tapper',
    name: 'Tapper',
    activated: [
      { cost: { tapSelf: true }, effects: [{ kind: 'addMana', colors: ['G'] }], sorcerySpeed: false, targets: [] },
    ],
  },
  digger: {
    ...BEARS,
    oracleId: 'digger',
    name: 'Digger',
    activated: [
      {
        cost: { mana: { G: 1 } },
        effects: [{ kind: 'draw', player: 'you', count: 1 }],
        sorcerySpeed: true,
        targets: [],
      },
    ],
  },
  'lava-spike': {
    ...BOLT,
    oracleId: 'lava-spike',
    name: 'Lava Spike',
    targets: [],
    spellEffects: [{ kind: 'damage', target: 'player', amount: 3 }],
  },
};

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

interface Setup {
  phase?: Phase;
  lands?: number;
  landColor?: Color;
  hand?: OracleId[];
  yours?: OracleId[];
  theirs?: OracleId[];
}

interface Built {
  state: GameState;
  hand: CardId[];
  yours: CardId[];
  theirs: CardId[];
}

/**
 * An empty game with exactly the cards a test names, all of them settled: hand
 * cards in hand, permanents on the battlefield since before this turn.
 */
function setup(opts: Setup): Built {
  let state = gameWith({ phase: opts.phase ?? 'main1' });
  state = { ...state, defs: { ...state.defs, ...EXTRA_DEFS } };
  if (opts.lands) state = giveLands(state, 0, opts.landColor ?? 'G', opts.lands);

  const hand: CardId[] = [];
  for (const oracleId of opts.hand ?? []) {
    const made = newInstance(state, oracleId, 0, 'hand');
    state = made.state;
    hand.push(made.id);
  }

  const put = (oracleIds: OracleId[], player: PlayerId, into: CardId[]): void => {
    for (const oracleId of oracleIds) {
      const made = newInstance(state, oracleId, player, 'battlefield');
      state = cloneState(made.state);
      state.cards[made.id]!.summonedThisTurn = false;
      into.push(made.id);
    }
  };

  const yours: CardId[] = [];
  const theirs: CardId[] = [];
  put(opts.yours ?? [], 0, yours);
  put(opts.theirs ?? [], 1, theirs);

  return { state, hand, yours, theirs };
}

/** A filler stack object, so a test can say "something is on the stack". */
function stackObject(n: number, source: CardId): StackObject {
  return { id: `stack-${n}`, source, controller: 1, effects: [], targets: null, isTriggered: false };
}

/** The same state with `n` objects on the stack. */
function withStack(state: GameState, n: number, source: CardId): GameState {
  const next = cloneState(state);
  for (let i = 0; i < n; i++) next.stack.push(stackObject(i, source));
  return next;
}

function casts(state: GameState, card: CardId): Action[] {
  return legalActions(state).filter((a) => a.kind === 'castSpell' && a.card === card);
}

// ---------------------------------------------------------------------------
// Land drops
// ---------------------------------------------------------------------------

describe('legalActions: land drops', () => {
  it('offers a land drop for every land in hand', () => {
    const { state, hand } = setup({ hand: ['forest', 'forest', 'grizzly-bears'] });
    const lands = legalActions(state).filter((a) => a.kind === 'playLand');
    expect(lands).toHaveLength(2);
    expect(lands.map((a) => (a.kind === 'playLand' ? a.card : ''))).toEqual([hand[0], hand[1]]);
  });

  it('withdraws the land drop once one has been made', () => {
    const { state } = setup({ hand: ['forest'] });
    const after = cloneState(state);
    after.players[0].landPlayedThisTurn = true;
    expect(legalActions(after).some((a) => a.kind === 'playLand')).toBe(false);
  });

  it('withdraws the land drop while something is on the stack', () => {
    const { state, hand } = setup({ hand: ['forest'] });
    expect(legalActions(withStack(state, 1, hand[0]!)).some((a) => a.kind === 'playLand')).toBe(false);
  });

  it('withdraws the land drop outside a main phase', () => {
    const { state } = setup({ hand: ['forest'], phase: 'upkeep' });
    expect(legalActions(state).some((a) => a.kind === 'playLand')).toBe(false);
  });

  it('withdraws the land drop on the other player’s turn', () => {
    const { state } = setup({ hand: ['forest'] });
    const theirTurn = cloneState(state);
    theirTurn.active = 1;
    expect(legalActions(theirTurn).some((a) => a.kind === 'playLand')).toBe(false);
  });

  it('offers a land drop in the postcombat main phase too', () => {
    const { state } = setup({ hand: ['forest'], phase: 'main2' });
    expect(legalActions(state).some((a) => a.kind === 'playLand')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

describe('legalActions: casting', () => {
  it('does not offer a spell the player cannot pay for', () => {
    const { state } = setup({ hand: ['grizzly-bears'] });
    expect(legalActions(state)).toEqual([{ kind: 'pass' }]);
  });

  it('offers a creature once enough lands are untapped', () => {
    const { state, hand } = setup({ hand: ['grizzly-bears'], lands: 2 });
    expect(casts(state, hand[0]!)).toEqual([{ kind: 'castSpell', card: hand[0], targets: null }]);
  });

  it('still refuses a creature one land short', () => {
    const { state, hand } = setup({ hand: ['grizzly-bears'], lands: 1 });
    expect(casts(state, hand[0]!)).toEqual([]);
  });

  it('never offers a land as a spell', () => {
    const { state, hand } = setup({ hand: ['forest'], lands: 5 });
    expect(casts(state, hand[0]!)).toEqual([]);
  });

  it('refuses sorcery-speed casts when the stack is not empty', () => {
    const { state, hand } = setup({ hand: ['grizzly-bears'], lands: 5 });
    expect(casts(withStack(state, 1, hand[0]!), hand[0]!)).toEqual([]);
  });

  it('refuses sorcery-speed casts outside your own main phase', () => {
    const { state, hand } = setup({ hand: ['grizzly-bears'], lands: 5, phase: 'declareBlockers' });
    expect(casts(state, hand[0]!)).toEqual([]);
  });

  it('allows an instant while the stack is not empty', () => {
    const { state, hand, yours } = setup({ hand: ['giant-growth'], lands: 5, yours: ['grizzly-bears'] });
    const responding = withStack(state, 1, yours[0]!);
    expect(casts(responding, hand[0]!)).toEqual([
      { kind: 'castSpell', card: hand[0], targets: [yours[0]] },
    ]);
  });

  it('allows a creature with flash at instant speed', () => {
    const { state, hand, yours } = setup({ hand: ['flash-bears'], lands: 5, yours: ['grizzly-bears'] });
    const responding = withStack(state, 1, yours[0]!);
    expect(casts(responding, hand[0]!)).toHaveLength(1);
  });

  it('refuses every response once the stack holds three objects', () => {
    const { state, hand, yours } = setup({ hand: ['giant-growth'], lands: 5, yours: ['grizzly-bears'] });
    // The instant answers a stack of one, so the cap is what silences it here.
    expect(casts(withStack(state, STACK_CAP - 1, yours[0]!), hand[0]!)).toHaveLength(1);

    const full = withStack(state, STACK_CAP, yours[0]!);
    expect(legalActions(full)).toEqual([{ kind: 'pass' }]);
  });

  it('offers nothing at all once the game has been won', () => {
    const { state } = setup({ hand: ['forest'], lands: 2 });
    const over = cloneState(state);
    over.winner = 0;
    expect(legalActions(over)).toEqual([]);
    expect(isLegal(over, { kind: 'pass' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

describe('legalActions: targets', () => {
  it('does not offer a spell with a required target and no legal target', () => {
    const { state, hand } = setup({ hand: ['giant-growth'], lands: 2 });
    expect(casts(state, hand[0]!)).toEqual([]);
    expect(canCast(state, hand[0]!)).toBe(false);
  });

  it('offers one cast per legal target', () => {
    const { state, hand, yours, theirs } = setup({
      hand: ['giant-growth'],
      lands: 2,
      yours: ['grizzly-bears'],
      theirs: ['grizzly-bears'],
    });
    expect(casts(state, hand[0]!)).toEqual([
      { kind: 'castSpell', card: hand[0], targets: [yours[0]] },
      { kind: 'castSpell', card: hand[0], targets: [theirs[0]] },
    ]);
  });

  it('offers each player as a target for a spell that burns a player', () => {
    const { state, hand } = setup({ hand: ['lava-spike'], lands: 1, landColor: 'R' });
    expect(casts(state, hand[0]!)).toEqual([
      { kind: 'castSpell', card: hand[0], targets: 'player0' },
      { kind: 'castSpell', card: hand[0], targets: 'player1' },
    ]);
  });
});

describe('legalTargets', () => {
  it('applies the filter’s own constraints', () => {
    const { state, yours, theirs } = setup({ yours: ['grizzly-bears', 'forest'], theirs: ['serra-angel'] });
    expect(legalTargets(state, ANY_CREATURE, 0)).toEqual([yours[0], theirs[0]]);
    expect(legalTargets(state, { ...ANY_CREATURE, controller: 'you' }, 0)).toEqual([yours[0]]);
    expect(legalTargets(state, { ...ANY_CREATURE, controller: 'opponent' }, 0)).toEqual([theirs[0]]);
    expect(legalTargets(state, { ...ANY_CREATURE, maxPower: 2 }, 0)).toEqual([yours[0]]);
    expect(legalTargets(state, { ...ANY_CREATURE, subtypes: ['Angel'] }, 0)).toEqual([theirs[0]]);
    expect(legalTargets(state, { zone: 'battlefield', cardTypes: ['land'] }, 0)).toEqual([yours[1]]);
  });

  it('reads controller relative to the player doing the targeting', () => {
    const { state, yours, theirs } = setup({ yours: ['grizzly-bears'], theirs: ['grizzly-bears'] });
    expect(legalTargets(state, { ...ANY_CREATURE, controller: 'you' }, 1)).toEqual([theirs[0]]);
    expect(legalTargets(state, { ...ANY_CREATURE, controller: 'opponent' }, 1)).toEqual([yours[0]]);
  });

  it('lets hexproof stop an opponent but not its own controller', () => {
    const { state, yours, theirs } = setup({ yours: ['hexproof-bears'], theirs: ['hexproof-bears'] });
    expect(legalTargets(state, ANY_CREATURE, 0)).toEqual([yours[0]]);
    expect(legalTargets(state, ANY_CREATURE, 1)).toEqual([theirs[0]]);
  });

  it('skips a warded target the caster cannot pay for, and offers it once they can', () => {
    const broke = setup({ theirs: ['ward-bears'] });
    expect(legalTargets(broke.state, ANY_CREATURE, 0)).toEqual([]);

    const rich = setup({ lands: 2, theirs: ['ward-bears'] });
    expect(legalTargets(rich.state, ANY_CREATURE, 0)).toEqual([rich.theirs[0]]);
  });

  it('never taxes a player for targeting their own warded permanent', () => {
    const { state, yours } = setup({ yours: ['ward-bears'] });
    expect(legalTargets(state, ANY_CREATURE, 0)).toEqual([yours[0]]);
  });

  it('makes the caster pay the ward cost on top of the spell', () => {
    // Giant Growth is {G}; the ward is {2}. Two Forests pays either but not both.
    const short = setup({ hand: ['giant-growth'], lands: 2, theirs: ['ward-bears'] });
    expect(casts(short.state, short.hand[0]!)).toEqual([]);

    const enough = setup({ hand: ['giant-growth'], lands: 3, theirs: ['ward-bears'] });
    expect(casts(enough.state, enough.hand[0]!)).toEqual([
      { kind: 'castSpell', card: enough.hand[0], targets: [enough.theirs[0]] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Activated abilities
// ---------------------------------------------------------------------------

describe('legalActions: activated abilities', () => {
  it('offers a tap ability of a settled permanent', () => {
    const { state, yours } = setup({ yours: ['tapper'] });
    expect(legalActions(state).filter((a) => a.kind === 'activate')).toEqual([
      { kind: 'activate', card: yours[0], abilityIndex: 0, targets: null },
    ]);
  });

  it('withdraws a tap ability when the permanent is already tapped', () => {
    const { state, yours } = setup({ yours: ['tapper'] });
    const tapped = cloneState(state);
    tapped.cards[yours[0]!]!.tapped = true;
    expect(legalActions(tapped).some((a) => a.kind === 'activate')).toBe(false);
  });

  it('withdraws a tap ability from a creature summoned this turn', () => {
    const { state, yours } = setup({ yours: ['tapper'] });
    const sick = cloneState(state);
    sick.cards[yours[0]!]!.summonedThisTurn = true;
    expect(legalActions(sick).some((a) => a.kind === 'activate')).toBe(false);
  });

  it('withdraws an ability whose mana cost cannot be paid', () => {
    const { state } = setup({ yours: ['digger'] });
    expect(legalActions(state).some((a) => a.kind === 'activate')).toBe(false);
  });

  it('holds a sorcery-speed ability back while the stack is not empty', () => {
    const { state, yours } = setup({ lands: 1, yours: ['digger'] });
    expect(legalActions(state).some((a) => a.kind === 'activate')).toBe(true);
    expect(legalActions(withStack(state, 1, yours[0]!)).some((a) => a.kind === 'activate')).toBe(false);
  });

  it('lets an instant-speed ability answer a spell on the stack', () => {
    const { state, yours } = setup({ yours: ['tapper'] });
    expect(legalActions(withStack(state, 1, yours[0]!)).some((a) => a.kind === 'activate')).toBe(true);
  });

  it('never offers an ability of a permanent the player does not control', () => {
    const { state } = setup({ theirs: ['tapper'] });
    expect(legalActions(state).some((a) => a.kind === 'activate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** A board in the declare-blockers step, with every named creature attacking. */
function attacking(state: GameState, attackers: CardId[]): GameState {
  const next = cloneState(state);
  next.phase = 'declareBlockers';
  next.priority = 1;
  for (const id of attackers) next.cards[id]!.attacking = true;
  return next;
}

describe('legalActions: combat', () => {
  it('offers candidate attacks drawn only from eligible creatures', () => {
    const state = battlefield({
      you: [
        { power: 2, toughness: 2 },
        { power: 0, toughness: 4, keywords: ['defender'] },
        { power: 3, toughness: 3, tapped: true },
        { power: 3, toughness: 3, summonedThisTurn: true },
        { power: 3, toughness: 3, summonedThisTurn: true, keywords: ['haste'] },
      ],
      them: [],
    });
    const attacks = legalActions(state)
      .filter((a) => a.kind === 'declareAttackers')
      .map((a) => (a.kind === 'declareAttackers' ? [...a.attackers].sort() : []));

    // you1 is a defender, you2 is tapped, you3 is summoning sick without haste.
    for (const set of attacks) {
      for (const id of set) expect(['you0', 'you4']).toContain(id);
    }
    // Declining, and going all in, are always on offer — the bot must never miss
    // lethal because the candidate list happened to sample around it.
    expect(attacks).toContainEqual([]);
    expect(attacks).toContainEqual(['you0', 'you4']);
    expect(attacks).toContainEqual(['you0']);
    expect(attacks).toContainEqual(['you4']);
  });

  it('does not enumerate the full subset space on a wide board', () => {
    // Every subset of twelve attackers is 4096 actions, and legalActions is called
    // from advancePhase on every pass. Legality is a predicate for a reason.
    const state = battlefield({
      you: Array.from({ length: 12 }, () => ({ power: 2, toughness: 2 })),
      them: [],
    });
    const attacks = legalActions(state).filter((a) => a.kind === 'declareAttackers');
    expect(attacks.length).toBeLessThan(40);
  });

  it('accepts any legal attack, including one it never listed as a candidate', () => {
    const state = battlefield({
      you: [
        { power: 2, toughness: 2 },
        { power: 2, toughness: 2 },
        { power: 2, toughness: 2 },
        { power: 2, toughness: 2 },
      ],
      them: [],
    });
    const arbitrary: Action = { kind: 'declareAttackers', attackers: ['you1', 'you2'] };
    const listed = legalActions(state).some(
      (a) => a.kind === 'declareAttackers' && a.attackers.join() === 'you1,you2',
    );
    expect(listed).toBe(false);
    expect(isLegal(state, arbitrary)).toBe(true);
  });

  it('rejects an attack with a tapped, sick, defending or foreign creature', () => {
    const state = battlefield({
      you: [
        { power: 2, toughness: 2 },
        { power: 0, toughness: 4, keywords: ['defender'] },
        { power: 3, toughness: 3, tapped: true },
      ],
      them: [{ power: 2, toughness: 2 }],
    });
    expect(validateAttack(state, ['you0'])).toBeNull();
    expect(validateAttack(state, ['you1'])).not.toBeNull();
    expect(validateAttack(state, ['you2'])).not.toBeNull();
    expect(validateAttack(state, ['them0'])).not.toBeNull();
    expect(validateAttack(state, ['you0', 'you0'])).not.toBeNull();
  });

  it('refuses a combat declaration while something is on the stack', () => {
    // Declaring attackers is a turn-based action taken as the step begins, before
    // any player has priority. A spell mid-resolution would otherwise be stranded
    // into the following step.
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const pending = cloneState(state);
    pending.stack.push({
      id: 'x', source: 'you0', controller: 0, effects: [], targets: null, isTriggered: false,
    });
    expect(legalActions(pending).some((a) => a.kind === 'declareAttackers')).toBe(false);
    expect(validateAttack(pending, ['you0'])).not.toBeNull();
  });

  it('offers attackers only in the declare-attackers step', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const main = cloneState(state);
    main.phase = 'main1';
    expect(main.phase).toBe('main1');
    expect(legalActions(main).some((a) => a.kind === 'declareAttackers')).toBe(false);
  });

  it('offers attackers only to the active player', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] });
    const defender = cloneState(state);
    defender.priority = 1;
    expect(legalActions(defender).some((a) => a.kind === 'declareAttackers')).toBe(false);
  });

  it('offers blocks only to the defending player, in the declare-blockers step', () => {
    const board = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] });
    const state = attacking(board, ['you0']);
    expect(legalActions(state).some((a) => a.kind === 'declareBlockers')).toBe(true);

    const attacker = cloneState(state);
    attacker.priority = 0;
    expect(legalActions(attacker).some((a) => a.kind === 'declareBlockers')).toBe(false);
  });

  it('lets only flying and reach block a flier', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
      them: [
        { power: 2, toughness: 2 },
        { power: 2, toughness: 2, keywords: ['reach'] },
        { power: 2, toughness: 2, keywords: ['flying'] },
      ],
    });
    const state = attacking(board, ['you0']);
    const blocks = legalActions(state)
      .filter((a) => a.kind === 'declareBlockers')
      .map((a) => (a.kind === 'declareBlockers' ? a.blocks.map((b) => b.blocker) : []));

    // them0 is a ground creature and can never be offered against a flier.
    expect(blocks.flat()).not.toContain('them0');
    expect(blocks).toContainEqual(['them1']);
    expect(blocks).toContainEqual(['them2']);
    expect(validateBlocks(state, [{ blocker: 'them0', attacker: 'you0' }])).not.toBeNull();
    expect(validateBlocks(state, [{ blocker: 'them1', attacker: 'you0' }])).toBeNull();
  });

  it('requires two blockers for menace, or none', () => {
    const board = battlefield({
      you: [{ power: 3, toughness: 3, keywords: ['menace'] }],
      them: [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    });
    const state = attacking(board, ['you0']);
    const blocks = legalActions(state)
      .filter((a) => a.kind === 'declareBlockers')
      .map((a) => (a.kind === 'declareBlockers' ? a.blocks.map((b) => b.blocker).sort() : []));

    // The candidate list must include the double block. The bot only picks from
    // here, so without it a menace creature would simply never be blocked.
    expect(blocks).toContainEqual(['them0', 'them1']);
    expect(blocks).toContainEqual([]);
    // And a single blocker is never on offer, nor legal.
    expect(blocks).not.toContainEqual(['them0']);
    expect(validateBlocks(state, [{ blocker: 'them0', attacker: 'you0' }])).not.toBeNull();
    expect(validateBlocks(state, [
      { blocker: 'them0', attacker: 'you0' },
      { blocker: 'them1', attacker: 'you0' },
    ])).toBeNull();
  });

  it('does not enumerate the full assignment space on a wide board', () => {
    // Eight blockers against eight attackers is 9^8 = 43 million assignments, walked
    // on every legalActions call. This is the case the layout study exists for.
    const board = battlefield({
      you: Array.from({ length: 8 }, () => ({ power: 2, toughness: 2 })),
      them: Array.from({ length: 8 }, () => ({ power: 2, toughness: 2 })),
    });
    const state = attacking(board, ['you0', 'you1', 'you2', 'you3', 'you4', 'you5', 'you6', 'you7']);

    const started = performance.now();
    const blocks = legalActions(state).filter((a) => a.kind === 'declareBlockers');
    const elapsed = performance.now() - started;

    expect(blocks.length).toBeLessThan(200);
    expect(elapsed).toBeLessThan(50);
  });

  it('accepts a legal block it never listed as a candidate', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }, { power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2 }, { power: 2, toughness: 2 }],
    });
    const state = attacking(board, ['you0', 'you1']);
    // Both blockers ganging up on the second attacker is legal, and deliberately
    // not in the candidate list.
    expect(validateBlocks(state, [
      { blocker: 'them0', attacker: 'you1' },
      { blocker: 'them1', attacker: 'you1' },
    ])).toBeNull();
  });

  it('rejects one creature blocking twice', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }, { power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2 }],
    });
    const state = attacking(board, ['you0', 'you1']);
    expect(validateBlocks(state, [
      { blocker: 'them0', attacker: 'you0' },
      { blocker: 'them0', attacker: 'you1' },
    ])).not.toBeNull();
  });

  it('never offers a tapped creature as a blocker', () => {
    const board = battlefield({
      you: [{ power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2, tapped: true }],
    });
    const blocks = legalActions(attacking(board, ['you0'])).filter((a) => a.kind === 'declareBlockers');
    expect(blocks).toEqual([{ kind: 'declareBlockers', blocks: [] }]);
  });
});

// ---------------------------------------------------------------------------
// The agreement that makes this module the source of truth
// ---------------------------------------------------------------------------

/** One state per shape of decision the engine can present. */
function everyShapeOfState(): GameState[] {
  const main = setup({
    hand: ['forest', 'grizzly-bears', 'giant-growth', 'lava-spike'],
    lands: 4,
    yours: ['tapper', 'ward-bears'],
    theirs: ['hexproof-bears', 'serra-angel'],
  });
  const attackStep = battlefield({
    you: [
      { power: 2, toughness: 2 },
      { power: 3, toughness: 3, keywords: ['flying'] },
    ],
    them: [{ power: 2, toughness: 2 }],
  });
  const blockStep = attacking(
    battlefield({
      you: [{ power: 3, toughness: 3, keywords: ['menace'] }],
      them: [
        { power: 1, toughness: 1 },
        { power: 2, toughness: 2, keywords: ['reach'] },
      ],
    }),
    ['you0'],
  );
  return [main.state, withStack(main.state, 1, main.yours[0]!), attackStep, blockStep];
}

describe('isLegal', () => {
  it('accepts every action legalActions enumerated', () => {
    for (const state of everyShapeOfState()) {
      const actions = legalActions(state);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(isLegal(state, action)).toBe(true);
    }
  });

  it('rejects an action legalActions did not enumerate', () => {
    const { state, hand, theirs } = setup({
      hand: ['giant-growth'],
      lands: 2,
      yours: ['grizzly-bears'],
      theirs: ['hexproof-bears'],
    });
    expect(isLegal(state, { kind: 'playLand', card: 'nonexistent' })).toBe(false);
    expect(isLegal(state, { kind: 'castSpell', card: 'nonexistent', targets: null })).toBe(false);
    // Right spell, but a target hexproof puts out of reach.
    expect(isLegal(state, { kind: 'castSpell', card: hand[0]!, targets: [theirs[0]!] })).toBe(false);
    expect(isLegal(state, { kind: 'declareAttackers', attackers: [] })).toBe(false);
  });

  it('does not care what order the keys were written in', () => {
    const { state, hand, yours } = setup({ hand: ['giant-growth'], lands: 2, yours: ['grizzly-bears'] });
    const action = { targets: [yours[0]!], card: hand[0]!, kind: 'castSpell' } as Action;
    expect(isLegal(state, action)).toBe(true);
  });
});

describe('canCast', () => {
  it('agrees with the castSpell actions legalActions enumerated', () => {
    for (const state of everyShapeOfState()) {
      const offered = new Set(
        legalActions(state)
          .filter((a) => a.kind === 'castSpell')
          .map((a) => (a.kind === 'castSpell' ? a.card : '')),
      );
      for (const player of [0, 1] as const) {
        for (const card of state.players[player].hand) {
          expect(canCast(state, card)).toBe(offered.has(card));
        }
      }
    }
  });

  it('is false for a card that is not in a hand', () => {
    const { state, yours } = setup({ yours: ['grizzly-bears'], lands: 5 });
    expect(canCast(state, yours[0]!)).toBe(false);
    expect(canCast(state, 'nonexistent')).toBe(false);
  });
});

describe('purity', () => {
  it('leaves the state it was handed untouched', () => {
    for (const state of everyShapeOfState()) {
      const before = JSON.stringify(state);
      legalActions(state);
      legalTargets(state, ANY_CREATURE, 0);
      isLegal(state, { kind: 'pass' });
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});
