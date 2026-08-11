/**
 * The Magician's voice.
 *
 * Two things are being tested here and they pull in opposite directions: that he
 * speaks at the moments worth speaking at, and that he shuts up the rest of the
 * time. The second is the harder property and most of this file is about it.
 *
 * Every test resets the shuffle bags first. The bags are the one piece of state
 * that survives a call, and a test that inherited another test's draws would be
 * asserting on the order the file happens to be written in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Action, CardId, GameState, Phase, PlayerId } from '../../src/engine/types';
import { cloneState, newInstance } from '../../src/engine/state';
import { SPEECH_LINES, resetSpeech, speechFor, type Tier } from '../../src/bot/personality';
import { battlefield, type CreatureSpec } from '../fixtures';

/** The Magician is player 1; the human is player 0. */
const HIM: PlayerId = 1;
const YOU: PlayerId = 0;

const TIERS: readonly Tier[] = ['apprentice', 'magician', 'archmage'];

/**
 * A board seen from the Magician's side, with him on the move.
 *
 * `his` and `yours` read the way the ribbon does, so a case says what the
 * Magician can see rather than which index of `players` holds it.
 */
function table(cfg: {
  his?: CreatureSpec[];
  yours?: CreatureSpec[];
  turn?: number;
  hisLife?: number;
  yourLife?: number;
  seed?: number;
  phase?: Phase;
}): GameState {
  const state = cloneState(battlefield({ you: cfg.yours ?? [], them: cfg.his ?? [] }));
  state.turn = cfg.turn ?? 5;
  state.phase = cfg.phase ?? 'main1';
  state.active = HIM;
  state.priority = HIM;
  state.players[HIM].life = cfg.hisLife ?? 20;
  state.players[YOU].life = cfg.yourLife ?? 20;
  state.rngSeed = cfg.seed ?? 1234;
  return state;
}

/** His creatures, in the order `table` put them down. */
function hisCreatures(state: GameState): CardId[] {
  return [...state.players[HIM].battlefield];
}

/** Put a card from the pool into his hand and hand back its id. */
function intoHand(state: GameState, oracleId: string): { state: GameState; id: CardId } {
  return newInstance(state, oracleId, HIM, 'hand');
}

/** Two of his against nothing of yours: the "empty table" moment, on any turn. */
function dominantTable(turn: number, seed = 808): GameState {
  return table({
    his: [{ power: 4, toughness: 4 }, { power: 4, toughness: 4 }],
    yours: [],
    turn,
    seed,
  });
}

/**
 * Walk turns until the empty-table line lands, and report where it landed.
 *
 * The softer categories are shaded by a seeded chance roll and held back by a
 * cooldown, so a test that pinned one turn would be asserting on the roll rather
 * than on the category. Silence across forty turns is a real failure and reports
 * as `null`.
 */
function firstDominantLine(tier: Tier, seed = 808): { turn: number; line: string } | null {
  for (let turn = 5; turn < 45; turn++) {
    const { state, id } = intoHand(dominantTable(turn, seed), 'grizzly-bears');
    const line = speechFor(state, { kind: 'castSpell', card: id, targets: null }, tier);
    if (line !== null) return { turn, line };
  }
  return null;
}

/** Every line in the book, flattened. */
function allLines(): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    for (const lines of Object.values(SPEECH_LINES[tier])) out.push(...lines);
  }
  return out;
}

beforeEach(() => {
  resetSpeech();
});

// ---------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------

describe('silence', () => {
  it('says nothing for a mundane action', () => {
    const state = table({ his: [{ power: 2, toughness: 2 }], yours: [{ power: 2, toughness: 2 }] });
    const { state: withLand, id } = intoHand(state, 'forest');

    expect(speechFor(withLand, { kind: 'playLand', card: id }, 'magician')).toBeNull();
  });

  it('never comments on a pass', () => {
    const state = table({ his: [{ power: 6, toughness: 6 }], yours: [] });
    for (const tier of TIERS) {
      expect(speechFor(state, { kind: 'pass' }, tier)).toBeNull();
    }
  });

  it('stays quiet through a whole quiet turn', () => {
    const state = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 7,
    });
    const { state: ready, id } = intoHand(state, 'forest');
    const mundane: Action[] = [
      { kind: 'pass' },
      { kind: 'playLand', card: id },
      { kind: 'tapLand', card: hisCreatures(ready)[0]! },
      { kind: 'declareAttackers', attackers: [] },
      { kind: 'declareBlockers', blocks: [] },
      { kind: 'scryDecision', toBottom: [] },
    ];

    for (const action of mundane) {
      expect(speechFor(ready, action, 'magician')).toBeNull();
    }
  });

  it('says nothing once the game is decided', () => {
    const state = cloneState(
      table({ his: [{ power: 9, toughness: 9 }], yours: [], turn: 9, yourLife: 3 }),
    );
    state.winner = HIM;

    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };
    expect(speechFor(state, swing, 'magician')).toBeNull();
  });

  it('an empty attack declaration is a pass, not a flourish', () => {
    const state = table({ his: [{ power: 9, toughness: 9 }], yours: [], turn: 1, yourLife: 2 });
    expect(speechFor(state, { kind: 'declareAttackers', attackers: [] }, 'magician')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The moments
// ---------------------------------------------------------------------------

describe('notable moments', () => {
  it('speaks when the swing is lethal if unblocked', () => {
    const state = table({
      his: [{ power: 4, toughness: 4 }, { power: 3, toughness: 3 }],
      yours: [{ power: 1, toughness: 1 }],
      turn: 6,
      yourLife: 6,
      phase: 'declareAttackers',
    });
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    const line = speechFor(state, swing, 'magician');
    expect(line).not.toBeNull();
    expect(SPEECH_LINES.magician.lethal).toContain(line);
  });

  it('counts double strike twice when deciding lethal', () => {
    const state = table({
      his: [{ power: 3, toughness: 3, keywords: ['double strike'] }],
      yours: [],
      turn: 6,
      yourLife: 6,
      phase: 'declareAttackers',
    });
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    expect(SPEECH_LINES.magician.lethal).toContain(speechFor(state, swing, 'magician'));
  });

  it('stays quiet on an attack that is short of lethal', () => {
    const state = table({
      his: [{ power: 3, toughness: 3 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 6,
      yourLife: 12,
      phase: 'declareAttackers',
    });
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    expect(speechFor(state, swing, 'magician')).toBeNull();
  });

  it('announces a five-drop', () => {
    const base = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 6,
    });
    const { state, id } = intoHand(base, 'serra-angel');

    const line = speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'archmage');
    expect(SPEECH_LINES.archmage.bomb).toContain(line);
  });

  it('announces a creature bigger than anything on the table', () => {
    const base = table({
      his: [{ power: 1, toughness: 1 }],
      yours: [{ power: 1, toughness: 1 }],
      turn: 6,
    });
    // Grizzly Bears is only a two-drop, but 2 beats every 1/1 in play.
    const { state, id } = intoHand(base, 'grizzly-bears');

    expect(SPEECH_LINES.magician.bomb).toContain(
      speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'magician'),
    );
  });

  it('does not call a small creature a bomb when bigger things are out', () => {
    const base = table({
      his: [{ power: 5, toughness: 5 }],
      yours: [{ power: 4, toughness: 4 }],
      turn: 6,
    });
    const { state, id } = intoHand(base, 'grizzly-bears');

    expect(speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'magician')).toBeNull();
  });

  it('speaks when removal will kill one of your creatures', () => {
    const base = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 6,
    });
    const { state, id } = intoHand(base, 'lightning-bolt');
    const victim = state.players[YOU].battlefield[0]!;

    const line = speechFor(state, { kind: 'castSpell', card: id, targets: [victim] }, 'magician');
    expect(SPEECH_LINES.magician.kill).toContain(line);
  });

  it('stays quiet when the removal will not finish the job', () => {
    const base = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 6 }],
      turn: 6,
    });
    const { state, id } = intoHand(base, 'lightning-bolt');
    const survivor = state.players[YOU].battlefield[0]!;

    expect(
      speechFor(state, { kind: 'castSpell', card: id, targets: [survivor] }, 'magician'),
    ).toBeNull();
  });

  it('stays quiet when the removal is pointed at his own creature', () => {
    const base = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 6,
    });
    const { state, id } = intoHand(base, 'lightning-bolt');
    const ownCreature = state.players[HIM].battlefield[0]!;

    expect(
      speechFor(state, { kind: 'castSpell', card: id, targets: [ownCreature] }, 'magician'),
    ).toBeNull();
  });

  it('opens with a flourish on his first turn', () => {
    const base = table({ his: [], yours: [], turn: 2 });
    const { state, id } = intoHand(base, 'forest');

    const line = speechFor(state, { kind: 'playLand', card: id }, 'apprentice');
    expect(SPEECH_LINES.apprentice.opening).toContain(line);
  });

  it('opens exactly once', () => {
    const first = table({ his: [], yours: [], turn: 1 });
    const withLand = intoHand(first, 'forest');
    expect(
      speechFor(withLand.state, { kind: 'playLand', card: withLand.id }, 'magician'),
    ).not.toBeNull();

    const second = intoHand(table({ his: [], yours: [], turn: 2 }), 'forest');
    expect(speechFor(second.state, { kind: 'playLand', card: second.id }, 'magician')).toBeNull();
  });

  it('mentions being on the ropes below five life', () => {
    const state = table({
      his: [{ power: 2, toughness: 2 }],
      yours: [{ power: 2, toughness: 2 }],
      turn: 8,
      hisLife: 3,
      phase: 'declareAttackers',
    });
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    expect(SPEECH_LINES.magician.lowLife).toContain(speechFor(state, swing, 'magician'));
  });

  it('takes his own board being swept with good grace', () => {
    let base = table({ his: [], yours: [{ power: 3, toughness: 3 }, { power: 3, toughness: 3 }] });
    base = newInstance(base, 'grizzly-bears', HIM, 'graveyard').state;
    base = newInstance(base, 'serra-angel', HIM, 'graveyard').state;
    const { state, id } = intoHand(base, 'grizzly-bears');

    const line = speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'archmage');
    expect(SPEECH_LINES.archmage.wiped).toContain(line);
  });

  it('does not claim a sweep when he simply has not played anything', () => {
    const base = table({
      his: [],
      yours: [{ power: 3, toughness: 3 }, { power: 3, toughness: 3 }],
    });
    const { state, id } = intoHand(base, 'grizzly-bears');

    expect(speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'archmage')).toBeNull();
  });

  it('remarks on an empty table opposite a full one', () => {
    // The softer categories are shaded by a seeded chance roll, so this walks
    // turns until one lands rather than pinning a seed that happens to work.
    const spoken = firstDominantLine('magician');
    expect(spoken).not.toBeNull();
    expect(SPEECH_LINES.magician.dominant).toContain(spoken!.line);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const lethalState = (seed: number): GameState =>
    table({
      his: [{ power: 7, toughness: 7 }],
      yours: [],
      turn: 6,
      yourLife: 5,
      seed,
      phase: 'declareAttackers',
    });

  it('the same state and seed give the same line', () => {
    const state = lethalState(99);
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    resetSpeech();
    const first = speechFor(state, swing, 'magician');
    resetSpeech();
    const second = speechFor(state, swing, 'magician');

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('asking twice about one moment does not draw twice', () => {
    const state = lethalState(99);
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };

    const first = speechFor(state, swing, 'magician');
    expect(speechFor(state, swing, 'magician')).toBe(first);
    expect(speechFor(state, swing, 'magician')).toBe(first);
  });

  it('different seeds do not all open on the same line', () => {
    const opened = new Set<string | null>();
    for (let seed = 0; seed < 40; seed++) {
      resetSpeech();
      const state = lethalState(seed);
      opened.add(speechFor(state, { kind: 'declareAttackers', attackers: hisCreatures(state) }, 'magician'));
    }
    expect(opened.size).toBeGreaterThan(1);
  });

  it('replays a whole sequence identically', () => {
    const run = (): Array<string | null> => {
      resetSpeech();
      const out: Array<string | null> = [];
      for (let turn = 2; turn <= 30; turn += 1) {
        const state = table({
          his: [{ power: 6, toughness: 6 }],
          yours: [],
          turn,
          yourLife: 5,
          seed: 4242,
          phase: 'declareAttackers',
        });
        out.push(
          speechFor(state, { kind: 'declareAttackers', attackers: hisCreatures(state) }, 'archmage'),
        );
      }
      return out;
    };

    expect(run()).toEqual(run());
  });

  it('never touches the state or the action it is given', () => {
    const state = lethalState(11);
    const swing: Action = { kind: 'declareAttackers', attackers: hisCreatures(state) };
    const stateBefore = JSON.stringify(state);
    const actionBefore = JSON.stringify(swing);

    speechFor(state, swing, 'magician');

    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(JSON.stringify(swing)).toBe(actionBefore);
  });
});

// ---------------------------------------------------------------------------
// Shuffle bags
// ---------------------------------------------------------------------------

describe('shuffle bags', () => {
  /** Swing for lethal every other turn, which is the fastest a bag can be drained. */
  function drawLethal(tier: Tier, draws: number, seed = 31): string[] {
    const out: string[] = [];
    for (let i = 0; i < draws; i++) {
      const state = table({
        his: [{ power: 8, toughness: 8 }],
        yours: [],
        turn: 3 + i * 2,
        yourLife: 4,
        seed,
        phase: 'declareAttackers',
      });
      const line = speechFor(
        state,
        { kind: 'declareAttackers', attackers: hisCreatures(state) },
        tier,
      );
      expect(line).not.toBeNull();
      out.push(line!);
    }
    return out;
  }

  it('does not repeat a line until the bag is empty', () => {
    const bag = SPEECH_LINES.magician.lethal;
    const drawn = drawLethal('magician', bag.length);

    expect(new Set(drawn).size).toBe(bag.length);
    expect([...drawn].sort()).toEqual([...bag].sort());
  });

  it('refills once the bag is empty, without repeating across the seam', () => {
    const bag = SPEECH_LINES.archmage.lethal;
    const drawn = drawLethal('archmage', bag.length * 2);

    expect(new Set(drawn.slice(0, bag.length)).size).toBe(bag.length);
    expect(new Set(drawn.slice(bag.length)).size).toBe(bag.length);
    expect(drawn[bag.length]).not.toBe(drawn[bag.length - 1]);
  });

  it('each tier draws from its own bag', () => {
    for (const tier of TIERS) {
      resetSpeech();
      for (const line of drawLethal(tier, SPEECH_LINES[tier].lethal.length)) {
        expect(SPEECH_LINES[tier].lethal).toContain(line);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe('pacing', () => {
  it('does not remark on the same standing board every turn', () => {
    let spoken = 0;
    for (let turn = 5; turn < 25; turn++) {
      const { state, id } = intoHand(dominantTable(turn), 'grizzly-bears');
      if (speechFor(state, { kind: 'castSpell', card: id, targets: null }, 'magician')) spoken += 1;
    }

    // Twenty turns of the same standing board. The cooldown alone caps it at
    // five, and the chance roll takes it below that.
    expect(spoken).toBeGreaterThan(0);
    expect(spoken).toBeLessThanOrEqual(5);
  });

  it('says at most one thing per turn outside the two big moments', () => {
    const spoken = firstDominantLine('magician');
    expect(spoken).not.toBeNull();

    const first = intoHand(dominantTable(spoken!.turn), 'grizzly-bears');
    const second = intoHand(first.state, 'grizzly-bears');

    // The same moment asked again answers the same.
    expect(
      speechFor(second.state, { kind: 'castSpell', card: first.id, targets: null }, 'magician'),
    ).toBe(spoken!.line);
    // A second play on the same turn gets nothing.
    expect(
      speechFor(second.state, { kind: 'castSpell', card: second.id, targets: null }, 'magician'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The book itself
// ---------------------------------------------------------------------------

describe('the lines', () => {
  it('every line fits the ribbon', () => {
    for (const line of allLines()) {
      expect(line.length).toBeLessThan(60);
    }
  });

  it('every tier has a bag for every moment, with room to shuffle', () => {
    for (const tier of TIERS) {
      const bags = Object.values(SPEECH_LINES[tier]);
      expect(bags.length).toBe(7);
      for (const bag of bags) {
        expect(bag.length).toBeGreaterThanOrEqual(4);
        expect(new Set(bag).size).toBe(bag.length);
      }
    }
  });

  it('no line is repeated between tiers', () => {
    const lines = allLines();
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('never taunts the player', () => {
    // Cruelty is a tone, not a word list, so this is a tripwire rather than a
    // proof: it catches the obvious regressions and the rest is code review.
    const unkind = /\b(idiot|stupid|fool|pathetic|loser|useless|worthless|dumb|weak|mistake|blunder)\b/i;
    for (const line of allLines()) {
      expect(line).not.toMatch(unkind);
    }
  });
});
