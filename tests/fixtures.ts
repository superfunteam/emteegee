/**
 * The card set and state builders every engine test shares.
 *
 * Two rules keep this file honest:
 *
 * - It imports its shapes from `src/engine/types.ts` like everything else. A
 *   fixture that invents its own idea of a `CardDef` stops being a fixture and
 *   starts being a second engine.
 * - The builders return a plain `GameState`, never a `ReduceResult`. Engine
 *   mutators take a `GameState` and return `{ state, events }`, so a test reads
 *   `declareAttackers(battlefield({...}), ['you0']).state`.
 *
 * The pool is deliberately tiny and deliberately classic: a land per color, a
 * vanilla 2/2, a 4/4 with two keywords, a pump instant, and a burn instant. That
 * is enough to exercise mana, combat, targeting, and the stack without any test
 * needing to author a card of its own.
 */

import type {
  CardDef,
  CardId,
  CardInstance,
  Color,
  GameState,
  Keyword,
  OracleId,
  Phase,
  PlayerId,
  PlayerState,
  StackObject,
  TargetFilter,
  Zone,
} from '../src/engine/types';
import { STARTING_LIFE } from '../src/engine/types';
import { cardsIn, cloneState, newInstance } from '../src/engine/state';

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

function basicLand(oracleId: OracleId, name: string, color: Color): CardDef {
  return makeDef({
    oracleId,
    name,
    cardTypes: ['land'],
    subtypes: [name],
    oracleText: `{T}: Add {${color}}.`,
    producesMana: [color],
  });
}

/** One creature, anywhere on the battlefield, either side. */
const ANY_CREATURE: TargetFilter = { zone: 'battlefield', controller: 'any', cardTypes: ['creature'] };

export const TEST_DEFS: Record<OracleId, CardDef> = {
  forest: basicLand('forest', 'Forest', 'G'),
  plains: basicLand('plains', 'Plains', 'W'),
  mountain: basicLand('mountain', 'Mountain', 'R'),
  island: basicLand('island', 'Island', 'U'),
  swamp: basicLand('swamp', 'Swamp', 'B'),

  'grizzly-bears': makeDef({
    oracleId: 'grizzly-bears',
    name: 'Grizzly Bears',
    manaCost: { G: 1, C: 1 },
    cmc: 2,
    colors: ['G'],
    cardTypes: ['creature'],
    subtypes: ['Bear'],
    power: 2,
    toughness: 2,
  }),

  'serra-angel': makeDef({
    oracleId: 'serra-angel',
    name: 'Serra Angel',
    manaCost: { W: 2, C: 3 },
    cmc: 5,
    colors: ['W'],
    cardTypes: ['creature'],
    subtypes: ['Angel'],
    power: 4,
    toughness: 4,
    oracleText: 'Flying, vigilance',
    keywords: ['flying', 'vigilance'],
  }),

  'giant-growth': makeDef({
    oracleId: 'giant-growth',
    name: 'Giant Growth',
    manaCost: { G: 1 },
    cmc: 1,
    colors: ['G'],
    cardTypes: ['instant'],
    oracleText: 'Target creature gets +3/+3 until end of turn.',
    targets: [ANY_CREATURE],
    spellEffects: [
      { kind: 'pump', target: ANY_CREATURE, power: 3, toughness: 3, duration: 'endOfTurn' },
    ],
  }),

  /**
   * Bolt points at a creature here, not "any target": `TargetFilter` describes
   * permanents, and `EffectTarget` can say `'player'` but not "a creature or a
   * player". Player burn is expressed by a card whose effect target is
   * `'player'`; this one is the creature-removal half.
   */
  'lightning-bolt': makeDef({
    oracleId: 'lightning-bolt',
    name: 'Lightning Bolt',
    manaCost: { R: 1 },
    cmc: 1,
    colors: ['R'],
    cardTypes: ['instant'],
    oracleText: 'Lightning Bolt deals 3 damage to target creature.',
    targets: [ANY_CREATURE],
    spellEffects: [{ kind: 'damage', target: ANY_CREATURE, amount: 3 }],
  }),
};

/** A placeholder for ids a test names without caring what they are. */
const BLANK: OracleId = 'test-blank';

const BLANK_DEF: CardDef = makeDef({
  oracleId: BLANK,
  name: 'Blank',
  // Twenty generic mana: never castable, so a blank in hand never widens legalActions.
  manaCost: { C: 20 },
  cmc: 20,
  cardTypes: ['instant'],
});

/** Twenty Forests, twenty Grizzly Bears, twenty Giant Growths. */
export const TEST_DECK: OracleId[] = [
  ...Array<OracleId>(20).fill('forest'),
  ...Array<OracleId>(20).fill('grizzly-bears'),
  ...Array<OracleId>(20).fill('giant-growth'),
];

const LAND_FOR_COLOR: Record<Color, OracleId> = {
  G: 'forest',
  W: 'plains',
  R: 'mountain',
  U: 'island',
  B: 'swamp',
};

// ---------------------------------------------------------------------------
// Reading and nudging a state
// ---------------------------------------------------------------------------

/** A player's hand, as a copy. */
export function handOf(s: GameState, p: PlayerId): CardId[] {
  return cardsIn(s, p, 'hand');
}

/** Put `n` untapped basic lands of one color onto a player's battlefield. */
export function giveLands(s: GameState, p: PlayerId, color: Color, n: number): GameState {
  let state = s;
  for (let i = 0; i < n; i++) {
    state = newInstance(state, LAND_FOR_COLOR[color], p, 'battlefield').state;
  }
  return state;
}

/**
 * Put a creature onto a player's battlefield, already settled — it has been
 * there since before this turn, so it can attack.
 */
export function putCreature(
  s: GameState,
  p: PlayerId,
  oracleId: OracleId,
): { state: GameState; id: CardId } {
  const made = newInstance(s, oracleId, p, 'battlefield');
  const state = cloneState(made.state);
  state.cards[made.id]!.summonedThisTurn = false;
  return { state, id: made.id };
}

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

/**
 * One creature on a board built by {@link battlefield}.
 *
 * `def` is accepted and ignored: the builder synthesizes a definition from
 * `power`, `toughness`, and `keywords`, so tests can label a row without the
 * label meaning anything.
 */
export interface CreatureSpec {
  power: number;
  toughness: number;
  keywords?: Keyword[];
  tapped?: boolean;
  summonedThisTurn?: boolean;
  damage?: number;
  tempPump?: { power: number; toughness: number };
  def?: string;
}

function emptyPlayer(id: PlayerId): PlayerState {
  return {
    id,
    life: STARTING_LIFE,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    landPlayedThisTurn: false,
    manaPool: {},
    mulligansTaken: 0,
    drewFromEmpty: false,
  };
}

function instanceOf(id: CardId, oracleId: OracleId, owner: PlayerId, zone: Zone): CardInstance {
  return {
    id,
    oracleId,
    controller: owner,
    owner,
    zone,
    tapped: false,
    summonedThisTurn: false,
    damage: 0,
    counters: { '+1/+1': 0, '-1/-1': 0 },
    tempPump: { power: 0, toughness: 0 },
    tempKeywords: [],
    isToken: false,
    attacking: false,
    blockedBy: [],
    damageOrderChosen: false,
  };
}

/**
 * A board mid-combat: both sides' creatures on the battlefield, player 0 active
 * with priority, stopped in the declare-attackers step.
 *
 * Your creatures are `you0`, `you1`, … and the opponent's are `them0`, `them1`,
 * …, so a combat case reads as a table:
 *
 * ```ts
 * battlefield({
 *   you:  [{ power: 5, toughness: 5, keywords: ['trample'] }],
 *   them: [{ power: 1, toughness: 2 }],
 * });
 * ```
 *
 * Each creature gets a definition synthesized from its spec, registered under
 * its own id, so nothing has to exist in `TEST_DEFS` first.
 */
export function battlefield(cfg: { you: CreatureSpec[]; them: CreatureSpec[] }): GameState {
  const defs: Record<OracleId, CardDef> = { ...TEST_DEFS, [BLANK]: BLANK_DEF };
  const cards: Record<CardId, CardInstance> = {};
  const players: [PlayerState, PlayerState] = [emptyPlayer(0), emptyPlayer(1)];

  const build = (specs: CreatureSpec[], player: PlayerId, prefix: string): void => {
    specs.forEach((spec, i) => {
      const id = `${prefix}${i}`;
      defs[id] = makeDef({
        oracleId: id,
        name: `Test ${prefix}${i}`,
        manaCost: { C: 1 },
        cmc: 1,
        cardTypes: ['creature'],
        subtypes: ['Test'],
        power: spec.power,
        toughness: spec.toughness,
        keywords: [...(spec.keywords ?? [])],
      });

      const card = instanceOf(id, id, player, 'battlefield');
      card.tapped = spec.tapped ?? false;
      card.summonedThisTurn = spec.summonedThisTurn ?? false;
      card.damage = spec.damage ?? 0;
      card.tempPump = { ...(spec.tempPump ?? { power: 0, toughness: 0 }) };
      cards[id] = card;
      players[player].battlefield.push(id);
    });
  };

  build(cfg.you, 0, 'you');
  build(cfg.them, 1, 'them');

  return {
    cards,
    defs,
    players,
    active: 0,
    priority: 0,
    turn: 1,
    phase: 'declareAttackers',
    stack: [],
    winner: null,
    rngSeed: 1,
    nextId: cfg.you.length + cfg.them.length,
    resolvingTrigger: false,
    pendingScry: null,
  };
}

/**
 * An otherwise empty game with a few things set the way a test needs them.
 *
 * Any `CardId` named in `hand`, `library`, or a stack object's `source` that has
 * no instance yet is materialised as a blank card in the right zone, so a test
 * can write `library: [[], ['a']]` and the state stays coherent.
 *
 * `priority` follows `active`.
 */
export function gameWith(
  overrides: Partial<{
    life: [number, number];
    hand: [CardId[], CardId[]];
    library: [CardId[], CardId[]];
    phase: Phase;
    active: PlayerId;
    stack: StackObject[];
  }>,
): GameState {
  const cards: Record<CardId, CardInstance> = {};
  const players: [PlayerState, PlayerState] = [emptyPlayer(0), emptyPlayer(1)];
  const active = overrides.active ?? 0;

  const materialise = (id: CardId, owner: PlayerId, zone: Zone): void => {
    if (!cards[id]) cards[id] = instanceOf(id, BLANK, owner, zone);
  };

  for (const p of [0, 1] as const) {
    for (const id of overrides.hand?.[p] ?? []) {
      materialise(id, p, 'hand');
      players[p].hand.push(id);
    }
    for (const id of overrides.library?.[p] ?? []) {
      materialise(id, p, 'library');
      players[p].library.push(id);
    }
  }

  const stack = overrides.stack ?? [];
  for (const object of stack) materialise(object.source, object.controller, 'stack');

  if (overrides.life) {
    players[0].life = overrides.life[0];
    players[1].life = overrides.life[1];
  }

  return {
    cards,
    defs: { ...TEST_DEFS, [BLANK]: BLANK_DEF },
    players,
    active,
    priority: active,
    turn: 1,
    phase: overrides.phase ?? 'main1',
    stack: [...stack],
    winner: null,
    rngSeed: 1,
    nextId: Object.keys(cards).length,
    resolvingTrigger: false,
    pendingScry: null,
  };
}
