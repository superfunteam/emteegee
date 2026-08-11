/**
 * The combat matrix.
 *
 * Every keyword in the pool earns its place by changing one of these outcomes,
 * so each row here is the interaction that makes the keyword mean something.
 *
 * Two conventions hold throughout:
 *
 * - Engine mutators take a `GameState` and return `{ state, events }`, so the
 *   helpers below unwrap `.state` between steps. Nothing chains a `ReduceResult`
 *   into the next call.
 * - An illegal declaration throws. Reaching one means `legalActions` offered a
 *   move that is not legal, which is an engine bug, not user error (spec §13).
 */

import { describe, expect, it } from 'vitest';
import {
  canAttack,
  canBlock,
  declareAttackers,
  declareBlockers,
  resolveDamageStep,
} from '../../src/engine/combat';
import { cloneState } from '../../src/engine/state';
import type { BlockAssignment, CardId, GameEvent, GameState, Trigger } from '../../src/engine/types';
import { battlefield } from '../fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const attack = (state: GameState, attackers: CardId[]): GameState =>
  declareAttackers(state, attackers).state;

const block = (state: GameState, blocks: BlockAssignment[]): GameState =>
  declareBlockers(state, blocks).state;

/** Declare, block, and resolve both damage steps: one whole combat. */
const swing = (state: GameState, attackers: CardId[], blocks: BlockAssignment[]): GameState =>
  resolveDamageStep(block(attack(state, attackers), blocks)).state;

const blocks = (...pairs: Array<[CardId, CardId]>): BlockAssignment[] =>
  pairs.map(([blocker, attacker]) => ({ blocker, attacker }));

const zoneOf = (state: GameState, card: CardId): string => state.cards[card]?.zone ?? 'gone';

/** Give one card's definition a trigger, without touching the state handed in. */
function withTrigger(base: GameState, card: CardId, trigger: Trigger): GameState {
  const next = cloneState(base);
  const existing = next.defs[next.cards[card]!.oracleId]!;
  return {
    ...next,
    defs: { ...next.defs, [existing.oracleId]: { ...existing, triggers: [...existing.triggers, trigger] } },
  };
}

const DRAW_TRIGGER = (on: Trigger['on']): Trigger => ({
  on,
  effects: [{ kind: 'draw', player: 'you', count: 1 }],
});

const eventTypes = (events: GameEvent[]): string[] => events.map((event) => event.type);

// ---------------------------------------------------------------------------
// Declaring attackers
// ---------------------------------------------------------------------------

describe('declareAttackers', () => {
  it('does not tap a creature with vigilance', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2, keywords: ['vigilance'] }], them: [] });
    const after = attack(state, ['you0']);
    expect(after.cards['you0']!.tapped).toBe(false);
    expect(after.cards['you0']!.attacking).toBe(true);
  });

  it('taps a creature without vigilance', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const result = declareAttackers(state, ['you0']);
    expect(result.state.cards['you0']!.tapped).toBe(true);
    expect(eventTypes(result.events)).toEqual(['ATTACK', 'TAP']);
  });

  it('throws when a creature with defender attacks', () => {
    const state = battlefield({ you: [{ power: 0, toughness: 4, keywords: ['defender'] }], them: [] });
    expect(canAttack(state, 'you0')).toBe(false);
    expect(() => declareAttackers(state, ['you0'])).toThrow();
  });

  it('throws when a creature summoned this turn attacks without haste', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, summonedThisTurn: true }],
      them: [],
    });
    expect(canAttack(state, 'you0')).toBe(false);
    expect(() => declareAttackers(state, ['you0'])).toThrow();
  });

  it('lets a creature with haste attack the turn it arrives', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['haste'], summonedThisTurn: true }],
      them: [],
    });
    expect(canAttack(state, 'you0')).toBe(true);
    expect(attack(state, ['you0']).cards['you0']!.attacking).toBe(true);
  });

  it('throws when a tapped creature attacks', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2, tapped: true }], them: [] });
    expect(canAttack(state, 'you0')).toBe(false);
    expect(() => declareAttackers(state, ['you0'])).toThrow();
  });

  it('throws when the defending player declares an attacker', () => {
    const state = battlefield({ you: [], them: [{ power: 2, toughness: 2 }] });
    expect(canAttack(state, 'them0')).toBe(false);
    expect(() => declareAttackers(state, ['them0'])).toThrow();
  });

  it('throws when the same creature is declared twice', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    expect(() => declareAttackers(state, ['you0', 'you0'])).toThrow();
  });

  it('declaring no attackers is legal and changes nothing', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const result = declareAttackers(state, []);
    expect(result.events).toEqual([]);
    expect(result.state.cards['you0']!.attacking).toBe(false);
    expect(result.state.cards['you0']!.tapped).toBe(false);
  });

  it('fires onAttack and puts the trigger on the stack', () => {
    const base = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const state = withTrigger(base, 'you0', DRAW_TRIGGER('onAttack'));
    const result = declareAttackers(state, ['you0']);
    expect(result.events).toContainEqual({ type: 'TRIGGER', source: 'you0', on: 'onAttack' });
    expect(result.state.stack).toHaveLength(1);
    expect(result.state.stack[0]!.source).toBe('you0');
  });

  it('never mutates the state handed in', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [] });
    const before = JSON.stringify(state);
    declareAttackers(state, ['you0']);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Declaring blockers
// ---------------------------------------------------------------------------

describe('declareBlockers', () => {
  it('throws when a ground creature blocks a flier', () => {
    const state = attack(
      battlefield({
        you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
        them: [{ power: 3, toughness: 3 }],
      }),
      ['you0'],
    );
    expect(canBlock(state, 'them0', 'you0')).toBe(false);
    expect(() => declareBlockers(state, blocks(['them0', 'you0']))).toThrow();
  });

  it('lets reach block a flier', () => {
    const state = attack(
      battlefield({
        you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
        them: [{ power: 3, toughness: 3, keywords: ['reach'] }],
      }),
      ['you0'],
    );
    expect(canBlock(state, 'them0', 'you0')).toBe(true);
    const after = block(state, blocks(['them0', 'you0']));
    expect(after.cards['you0']!.blockedBy).toContain('them0');
    expect(after.cards['them0']!.blocking).toBe('you0');
  });

  it('lets a flier block a flier', () => {
    const state = attack(
      battlefield({
        you: [{ power: 2, toughness: 2, keywords: ['flying'] }],
        them: [{ power: 3, toughness: 3, keywords: ['flying'] }],
      }),
      ['you0'],
    );
    expect(block(state, blocks(['them0', 'you0'])).cards['you0']!.blockedBy).toEqual(['them0']);
  });

  it('throws when menace is blocked by exactly one creature', () => {
    const state = attack(
      battlefield({
        you: [{ power: 3, toughness: 3, keywords: ['menace'] }],
        them: [
          { power: 1, toughness: 1 },
          { power: 1, toughness: 1 },
        ],
      }),
      ['you0'],
    );
    expect(() => declareBlockers(state, blocks(['them0', 'you0']))).toThrow();
  });

  it('lets menace be blocked by two creatures', () => {
    const state = attack(
      battlefield({
        you: [{ power: 3, toughness: 3, keywords: ['menace'] }],
        them: [
          { power: 1, toughness: 1 },
          { power: 1, toughness: 1 },
        ],
      }),
      ['you0'],
    );
    const after = block(state, blocks(['them0', 'you0'], ['them1', 'you0']));
    expect(after.cards['you0']!.blockedBy).toHaveLength(2);
  });

  it('lets menace through unblocked', () => {
    const state = attack(
      battlefield({
        you: [{ power: 3, toughness: 3, keywords: ['menace'] }],
        them: [{ power: 1, toughness: 1 }],
      }),
      ['you0'],
    );
    expect(block(state, []).cards['you0']!.blockedBy).toEqual([]);
  });

  it('throws when a tapped creature blocks', () => {
    const state = attack(
      battlefield({
        you: [{ power: 2, toughness: 2 }],
        them: [{ power: 2, toughness: 2, tapped: true }],
      }),
      ['you0'],
    );
    expect(canBlock(state, 'them0', 'you0')).toBe(false);
    expect(() => declareBlockers(state, blocks(['them0', 'you0']))).toThrow();
  });

  it('throws when a creature blocks something that is not attacking', () => {
    const state = attack(
      battlefield({
        you: [
          { power: 2, toughness: 2 },
          { power: 2, toughness: 2 },
        ],
        them: [{ power: 2, toughness: 2 }],
      }),
      ['you0'],
    );
    expect(canBlock(state, 'them0', 'you1')).toBe(false);
    expect(() => declareBlockers(state, blocks(['them0', 'you1']))).toThrow();
  });

  it('throws when one blocker is assigned to two attackers', () => {
    const state = attack(
      battlefield({
        you: [
          { power: 2, toughness: 2 },
          { power: 2, toughness: 2 },
        ],
        them: [{ power: 2, toughness: 2 }],
      }),
      ['you0', 'you1'],
    );
    expect(() => declareBlockers(state, blocks(['them0', 'you0'], ['them0', 'you1']))).toThrow();
  });

  it('keeps blockedBy in the order the blocks were declared', () => {
    const state = attack(
      battlefield({
        you: [{ power: 5, toughness: 5 }],
        them: [
          { power: 1, toughness: 1 },
          { power: 1, toughness: 1 },
        ],
      }),
      ['you0'],
    );
    expect(block(state, blocks(['them1', 'you0'], ['them0', 'you0'])).cards['you0']!.blockedBy).toEqual([
      'them1',
      'them0',
    ]);
  });

  it('fires onBlock on the blocker and reports a BLOCK event', () => {
    const base = attack(
      battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] }),
      ['you0'],
    );
    const state = withTrigger(base, 'them0', DRAW_TRIGGER('onBlock'));
    const result = declareBlockers(state, blocks(['them0', 'you0']));
    expect(result.events).toContainEqual({ type: 'BLOCK', blocker: 'them0', attacker: 'you0' });
    expect(result.events).toContainEqual({ type: 'TRIGGER', source: 'them0', on: 'onBlock' });
  });

  it('never mutates the state handed in', () => {
    const state = attack(
      battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] }),
      ['you0'],
    );
    const before = JSON.stringify(state);
    declareBlockers(state, blocks(['them0', 'you0']));
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

describe('resolveDamageStep', () => {
  it('sends an unblocked attacker at the defending player', () => {
    const state = battlefield({ you: [{ power: 4, toughness: 4 }], them: [] });
    const after = swing(state, ['you0'], []);
    expect(after.players[1].life).toBe(16);
    expect(after.players[0].life).toBe(20);
  });

  it('deals nothing to the player when the attacker is blocked and has no trample', () => {
    const state = battlefield({
      you: [{ power: 4, toughness: 4 }],
      them: [{ power: 0, toughness: 8 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[1].life).toBe(20);
    expect(after.cards['them0']!.damage).toBe(4);
  });

  it('trades damage between an attacker and its blocker', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2 }],
      them: [{ power: 2, toughness: 2 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'you0')).toBe('graveyard');
    expect(zoneOf(after, 'them0')).toBe('graveyard');
  });

  it('kills a creature of any size with deathtouch', () => {
    const state = battlefield({
      you: [{ power: 1, toughness: 1, keywords: ['deathtouch'] }],
      them: [{ power: 10, toughness: 10 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
  });

  it('lets a deathtouch blocker kill the attacker it blocks', () => {
    const state = battlefield({
      you: [{ power: 6, toughness: 6 }],
      them: [{ power: 1, toughness: 1, keywords: ['deathtouch'] }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'you0')).toBe('graveyard');
  });

  it('assigns lethal to the blocker then spills the rest with trample', () => {
    const state = battlefield({
      you: [{ power: 5, toughness: 5, keywords: ['trample'] }],
      them: [{ power: 1, toughness: 2 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[1].life).toBe(17);
    expect(zoneOf(after, 'them0')).toBe('graveyard');
  });

  it('counts existing damage when working out lethal for trample', () => {
    const state = battlefield({
      you: [{ power: 5, toughness: 5, keywords: ['trample'] }],
      them: [{ power: 1, toughness: 4, damage: 2 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[1].life).toBe(17);
  });

  it('needs only one damage per blocker with trample and deathtouch', () => {
    const state = battlefield({
      you: [{ power: 5, toughness: 5, keywords: ['trample', 'deathtouch'] }],
      them: [{ power: 1, toughness: 4 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[1].life).toBe(16);
    expect(zoneOf(after, 'them0')).toBe('graveyard');
  });

  it('walks multiple blockers in order, lethal to each before the next', () => {
    const state = battlefield({
      you: [{ power: 5, toughness: 6, keywords: ['trample'] }],
      them: [
        { power: 1, toughness: 2 },
        { power: 1, toughness: 2 },
      ],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0'], ['them1', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
    expect(zoneOf(after, 'them1')).toBe('graveyard');
    expect(after.players[1].life).toBe(19);
    expect(after.cards['you0']!.damage).toBe(2);
  });

  it('kills before the regular step with first strike, so no damage comes back', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['first strike'] }],
      them: [{ power: 2, toughness: 2 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
    expect(zoneOf(after, 'you0')).toBe('battlefield');
    expect(after.cards['you0']!.damage).toBe(0);
  });

  it('lets a first strike blocker kill an attacker before it strikes back', () => {
    const state = battlefield({
      you: [{ power: 3, toughness: 3 }],
      them: [{ power: 3, toughness: 3, keywords: ['first strike'] }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'you0')).toBe('graveyard');
    expect(zoneOf(after, 'them0')).toBe('battlefield');
    expect(after.cards['them0']!.damage).toBe(0);
  });

  it('does not spill first strike damage to the player twice', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2, keywords: ['first strike'] }], them: [] });
    const after = swing(state, ['you0'], []);
    expect(after.players[1].life).toBe(18);
  });

  it('deals damage in both steps with double strike', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['double strike'] }],
      them: [{ power: 1, toughness: 3 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
    expect(after.cards['you0']!.damage).toBe(1);
  });

  it('hits the player twice with an unblocked double striker', () => {
    const state = battlefield({ you: [{ power: 3, toughness: 3, keywords: ['double strike'] }], them: [] });
    const after = swing(state, ['you0'], []);
    expect(after.players[1].life).toBe(14);
  });

  it('gains life on damage dealt with lifelink, not on cast', () => {
    const state = battlefield({ you: [{ power: 3, toughness: 3, keywords: ['lifelink'] }], them: [] });
    const declared = attack(state, ['you0']);
    expect(declared.players[0].life).toBe(20);

    const after = resolveDamageStep(block(declared, []));
    expect(after.state.players[0].life).toBe(23);
    expect(after.state.players[1].life).toBe(17);
    expect(after.events).toContainEqual({ type: 'LIFE_CHANGE', player: 0, from: 20, to: 23 });
  });

  it('gains life for every point a lifelinker deals, blockers included', () => {
    const state = battlefield({
      you: [{ power: 5, toughness: 5, keywords: ['lifelink', 'trample'] }],
      them: [{ power: 1, toughness: 2 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[0].life).toBe(25);
    expect(after.players[1].life).toBe(17);
  });

  it('gains life in both steps with lifelink and double strike', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['lifelink', 'double strike'] }],
      them: [],
    });
    const after = swing(state, ['you0'], []);
    expect(after.players[0].life).toBe(24);
    expect(after.players[1].life).toBe(16);
  });

  it('gains life for a lifelink blocker too', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 4 }],
      them: [{ power: 3, toughness: 4, keywords: ['lifelink'] }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(after.players[1].life).toBe(23);
  });

  it('stays blocked after its blocker dies in the first strike step', () => {
    const state = battlefield({
      you: [{ power: 2, toughness: 2, keywords: ['double strike'] }],
      them: [{ power: 1, toughness: 1 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
    expect(after.players[1].life).toBe(20);
  });

  it('tramples everything through once its blocker is dead', () => {
    const state = battlefield({
      you: [{ power: 4, toughness: 4, keywords: ['double strike', 'trample'] }],
      them: [{ power: 1, toughness: 1 }],
    });
    const after = swing(state, ['you0'], blocks(['them0', 'you0']));
    expect(zoneOf(after, 'them0')).toBe('graveyard');
    expect(after.players[1].life).toBe(13);
  });

  it('reports damage, deaths and life changes as events', () => {
    const state = block(
      attack(battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 1, toughness: 1 }] }), ['you0']),
      blocks(['them0', 'you0']),
    );
    const result = resolveDamageStep(state);
    expect(result.events).toContainEqual({
      type: 'DAMAGE',
      source: 'you0',
      target: 'them0',
      amount: 2,
      isPlayer: false,
    });
    expect(result.events).toContainEqual({ type: 'DIE', card: 'them0' });
    expect(eventTypes(result.events)).toContain('ZONE_CHANGE');
  });

  it('reports player damage as a DAMAGE event followed by a LIFE_CHANGE', () => {
    const state = block(attack(battlefield({ you: [{ power: 3, toughness: 3 }], them: [] }), ['you0']), []);
    const result = resolveDamageStep(state);
    expect(result.events).toContainEqual({
      type: 'DAMAGE',
      source: 'you0',
      target: 1,
      amount: 3,
      isPlayer: true,
    });
    expect(result.events).toContainEqual({ type: 'LIFE_CHANGE', player: 1, from: 20, to: 17 });
  });

  it('fires onDies when a creature is killed by combat damage', () => {
    const base = block(
      attack(battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 1, toughness: 1 }] }), ['you0']),
      blocks(['them0', 'you0']),
    );
    const state = withTrigger(base, 'them0', DRAW_TRIGGER('onDies'));
    const result = resolveDamageStep(state);
    expect(result.events).toContainEqual({ type: 'TRIGGER', source: 'them0', on: 'onDies' });
  });

  it('fires onDealCombatDamage for a creature that dealt combat damage', () => {
    const base = block(attack(battlefield({ you: [{ power: 2, toughness: 2 }], them: [] }), ['you0']), []);
    const state = withTrigger(base, 'you0', DRAW_TRIGGER('onDealCombatDamage'));
    const result = resolveDamageStep(state);
    expect(result.events).toContainEqual({ type: 'TRIGGER', source: 'you0', on: 'onDealCombatDamage' });
  });

  it('does nothing at all when nobody is in combat', () => {
    const state = battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] });
    const result = resolveDamageStep(state);
    expect(result.events).toEqual([]);
    expect(result.state.players[1].life).toBe(20);
  });

  it('never mutates the state handed in', () => {
    const state = block(
      attack(battlefield({ you: [{ power: 2, toughness: 2 }], them: [{ power: 2, toughness: 2 }] }), ['you0']),
      blocks(['them0', 'you0']),
    );
    const before = JSON.stringify(state);
    resolveDamageStep(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});
