/**
 * The Magician's voice.
 *
 * `chooseAction` decides what he does; this decides whether he says anything
 * about it. The two are deliberately separate — personality never reaches into
 * the search, and the search never knows there is an audience. Everything here
 * is a read: `speechFor` takes the state as it stands *before* the action it was
 * handed, and returns a ribbon line or `null`.
 *
 * Four properties hold, and each one is load-bearing:
 *
 * 1. **Silence is the default.** Seven categories of notable moment are
 *    recognised and everything else returns `null`. A line that fires on every
 *    land drop is a line the player learns to ignore, and an opponent you ignore
 *    is not an opponent. On top of the categories sit three independent brakes —
 *    a per-category cooldown in turns, at most one line per turn, and a seeded
 *    chance roll — which together land the rate near one line every three or
 *    four turns.
 * 2. **Shuffle bags, not dice.** Each (tier, category) pair draws from its own
 *    bag of lines; a line cannot come up twice until its bag has emptied and
 *    refilled, and a refill never opens with the line the previous bag closed
 *    on. Repetition is what makes a scripted opponent feel scripted.
 * 3. **Deterministic.** Every bag order and every chance roll comes from
 *    `makeRng` seeded off `state.rngSeed`. No `Math.random`, no clock. The same
 *    seed and the same sequence of moments produce the same performance, which
 *    is what makes any of this testable.
 * 4. **He is smug about himself, never cruel about you.** He boasts, he
 *    flourishes, and when the board is cleared out from under him he says so
 *    with good grace. Not one line in this file comments on a mistake the player
 *    made. This is the first opponent a beginner will ever face and he has to be
 *    someone they want to play again.
 *
 * Tier changes the flavour and not the frequency: the same moments are noticed
 * and the same brakes apply, but the apprentice fumbles through his patter, the
 * magician has it polished, and the archmage barely raises his voice.
 */

import type { Action, Effect, GameState, PlayerId } from '../engine/types';
import { hasKeyword, isCreature, opponentOf, powerOf, toughnessOf } from '../engine/state';
import { makeRng, shuffle } from '../engine/rng';
import type { Tier } from './magician';

/**
 * The three difficulties, re-exported so a caller that only wants the voice does
 * not have to reach into the search module for the type. The declaration lives
 * there because that is what the tier actually selects: a search. Here it picks
 * a shelf of lines, and the compiler keeps the two spellings from drifting.
 */
export type { Tier };

/** The kinds of moment worth breaking silence for. */
type Category =
  /** The curtain going up on his first turn. */
  | 'opening'
  /** An attack that wins the game if nothing blocks it. */
  | 'lethal'
  /** A five-drop, or a creature bigger than anything already on the table. */
  | 'bomb'
  /** Removal pointed at one of the player's creatures. */
  | 'kill'
  /** His side of the board gone while the player's stands. */
  | 'wiped'
  /** His life below five. */
  | 'lowLife'
  /** The player's board empty while his is not. */
  | 'dominant';

/**
 * The order categories are tested in, most notable first. Exactly one fires per
 * action: a turn where he drops a bomb *and* swings for lethal is a turn with
 * one line in it, not two.
 */
const CATEGORY_ORDER: readonly Category[] = [
  'opening',
  'lethal',
  'bomb',
  'kill',
  'wiped',
  'lowLife',
  'dominant',
];

/**
 * Turns that must pass before a category may fire again.
 *
 * The state-shaped categories get the long cooldowns because their conditions
 * persist: a player with an empty board often has an empty board for three turns
 * running, and without this he would remark on it every one of them.
 */
const COOLDOWN: Record<Category, number> = {
  opening: 3,
  lethal: 2,
  bomb: 2,
  kill: 2,
  wiped: 4,
  lowLife: 3,
  dominant: 4,
};

/**
 * How often a category speaks when it is otherwise clear to.
 *
 * The two that are certain are the two that happen at most once in a game's
 * worth of turns anyway — the opening flourish and a swing for the win. The rest
 * are shaded so that noticing a thing and mentioning it are not the same event.
 */
const CHANCE: Record<Category, number> = {
  opening: 1,
  lethal: 1,
  bomb: 0.8,
  kill: 0.65,
  wiped: 0.8,
  lowLife: 0.7,
  dominant: 0.5,
};

/**
 * Categories allowed past the one-line-per-turn rule.
 *
 * Only the two that are a whole turn's worth of drama on their own. Without this
 * the curtain line could be eaten by a land drop, and a lethal swing on the same
 * turn as a bomb would go out in silence — which is the one moment the ribbon
 * exists for.
 */
const INTERRUPTS: Record<Category, boolean> = {
  opening: true,
  lethal: true,
  bomb: false,
  kill: false,
  wiped: false,
  lowLife: false,
  dominant: false,
};

/** Turns during which the opening flourish is still his opening flourish. */
const OPENING_WINDOW = 2;

/** A creature at or above this cost is worth announcing on cost alone. */
const BOMB_CMC = 5;

/** Below this much life he is in trouble and admits it. */
const LOW_LIFE = 5;

/**
 * Every line he can say, by tier and by moment.
 *
 * Each stays under the ribbon's ~60 character budget, and each is about his own
 * performance. The apprentice is delighted and slightly out of his depth, the
 * magician is a working professional enjoying himself, and the archmage has done
 * this before and does not need you to know it.
 */
export const SPEECH_LINES: Record<Tier, Record<Category, readonly string[]>> = {
  apprentice: {
    opening: [
      "Welcome! I've been practising this one all week.",
      'Ladies and gentlemen... well. Just you. Hello!',
      'First trick of the evening. Wish me luck.',
      "Watch closely! Or don't, that's fine too.",
      'I have the whole routine memorised. Mostly.',
    ],
    lethal: [
      'Everybody, all at once! Please work!',
      'This is the big finish! I think! Charge!',
      "Swinging with everything. Don't tell my tutor.",
      'Grand finale! Assuming I counted right.',
      'All of them! That is the whole plan!',
    ],
    bomb: [
      'Ta-daa! I made it appear! Mostly on purpose.',
      "It's bigger than I remembered. Good, right?",
      'I found this at the bottom of my hat.',
      "Oh! This one's my favourite. Look at it!",
      'Behold! ...Behold harder, it is very good.',
    ],
    kill: [
      "Now you see it! Now I've... misplaced it.",
      "Vanishing act! I've been working on that one.",
      'Poof! Sorry. Nothing personal, lovely creature.',
      'Into the hat it goes. No refunds.',
      'It went somewhere. I never ask where.',
    ],
    wiped: [
      'My whole cast! Gone! How embarrassing.',
      'Well. The stage is very clean now.',
      'I shall rebuild. I have notes. Somewhere.',
      'That was my entire troupe. Bravo, honestly.',
    ],
    lowLife: [
      'Yikes. That was not in the script.',
      'I am fine! This is a dramatic pause.',
      'Ooh, that stung. Well done, honestly.',
      'Still standing! Barely, but standing.',
    ],
    dominant: [
      'A whole stage to myself! Gosh.',
      "Don't worry, you'll draw something lovely.",
      'All this room and I still get stage fright.',
      'The board is mine. Briefly, I am sure.',
    ],
  },

  magician: {
    opening: [
      'Shall we begin? The cards are already warm.',
      'Good evening. Please, examine the deck.',
      'Nothing up my sleeves. Sleeves are for amateurs.',
      'For my first trick: an ordinary game of cards.',
      "Take a seat. This won't take long. It will be fun.",
    ],
    lethal: [
      'And now, the disappearing life total.',
      "For my final trick, I'll need a volunteer.",
      "Watch the hands. That's where the ending is.",
      'All of them. Every last one. Curtain.',
      'The trick is that there is no trick.',
    ],
    bomb: [
      'For my next trick, something enormous.',
      'From the hat, a rabbit. A rather large rabbit.',
      'I did say to watch the other hand.',
      "Every act needs a headliner. Here's mine.",
      'Voila. No wires, no mirrors, all teeth.',
    ],
    kill: [
      'Now you see it. Now you never did.',
      'A disappearance, cleanly done.',
      'Every act needs one vanishing. That was it.',
      "I'll return it after the show. I won't.",
      'Misdirection, and then an empty stage.',
    ],
    wiped: [
      "An empty stage. Bold staging, I'll allow it.",
      'You cleared the table. That was well played.',
      "Intermission, then. I'll be right back.",
      'Every magician needs one empty hat. Hm.',
    ],
    lowLife: [
      'A close shave. Excellent theatre, truly.',
      "Ah — you've found the trapdoor. Nicely done.",
      'The escape act is my strongest routine.',
      "Bleeding, but smiling. It's part of the show.",
    ],
    dominant: [
      'The stage is mine for a moment. Only a moment.',
      "An empty table is a magician's favourite prop.",
      "I'll keep it warm for whatever you draw.",
      'Room to work at last. Take your time.',
    ],
  },

  archmage: {
    opening: [
      'I have done this a great many times.',
      "Begin when you're ready. I already have.",
      "The ending is written. Let's enjoy the middle.",
      'Sit. Watch. The cards know their parts.',
      'No flourish tonight. Only the work.',
    ],
    lethal: [
      'The final movement. Do try to enjoy it.',
      'Everything I have. It is enough.',
      'This was decided three turns ago.',
      'Now the trick reveals itself.',
      'I have been holding this since the draw.',
    ],
    bomb: [
      'This one has been waiting in the wings.',
      'You may applaud now or later. Later is fine.',
      'I kept the best card for the best moment.',
      'Behold. No flourish required.',
      'It was always going to be this one.',
    ],
    kill: [
      'Removed. Quietly, and without ceremony.',
      "That piece wasn't part of the finale.",
      'A tidy vanishing. The stage is clearer.',
      'Gone. The trick is knowing when.',
      'I only ever remove what matters.',
    ],
    wiped: [
      'A clean stage. I have played from worse.',
      'Well struck. I will build again.',
      'You emptied the table. Genuinely elegant.',
      'An empty board is only a quiet one.',
    ],
    lowLife: [
      'Closer than I usually allow. Noted.',
      'A fine performance. The act is not over.',
      'You have my full attention now.',
      'Danger improves the ending. Carry on.',
    ],
    dominant: [
      'A quiet table. It rarely stays quiet.',
      'The stage is clear. That is temporary.',
      'I hold the board. Draw well.',
      'Space to work. I intend to use it.',
    ],
  },
};

// ---------------------------------------------------------------------------
// Recognising a moment
// ---------------------------------------------------------------------------

/**
 * Is this action a visible move rather than bookkeeping?
 *
 * A land drop is excluded on purpose. It is the most common thing he does all
 * game, and hanging the state-shaped categories off it would put a line on
 * nearly every turn — the exact failure mode the ribbon is trying to avoid.
 * Declaring no attackers and declaring no blockers are not moves; the engine
 * treats them as spelled-out passes and so does he.
 */
function isPlay(action: Action): boolean {
  switch (action.kind) {
    case 'castSpell':
    case 'activate':
      return true;
    case 'declareAttackers':
      return action.attackers.length > 0;
    case 'declareBlockers':
      return action.blocks.length > 0;
    default:
      return false;
  }
}

/** The first thing he actually does, land drop included — that is the curtain. */
function isFirstGesture(action: Action): boolean {
  return action.kind === 'playLand' || isPlay(action);
}

/** How many creatures this player has on the battlefield right now. */
function creatureCount(state: GameState, player: PlayerId): number {
  let count = 0;
  for (const id of state.players[player].battlefield) {
    if (!state.cards[id]) continue;
    if (isCreature(state, id)) count += 1;
  }
  return count;
}

/** The largest power on the table, or `null` when the table is bare. */
function biggestPower(state: GameState): number | null {
  let biggest: number | null = null;
  for (const player of state.players) {
    for (const id of player.battlefield) {
      if (!state.cards[id]) continue;
      if (!isCreature(state, id)) continue;
      const power = powerOf(state, id);
      if (biggest === null || power > biggest) biggest = power;
    }
  }
  return biggest;
}

/**
 * Is he casting a creature worth a flourish?
 *
 * Either it costs five or more, or it is bigger than everything already in play.
 * The second clause needs a non-empty board to mean anything: on an empty table
 * a 1/1 is trivially the biggest creature in the game, and announcing it would
 * be the opposite of a bomb.
 */
function isBomb(state: GameState, action: Action, me: PlayerId): boolean {
  if (action.kind !== 'castSpell') return false;

  const card = state.cards[action.card];
  if (!card || card.controller !== me) return false;

  const definition = state.defs[card.oracleId];
  if (!definition || !definition.cardTypes.includes('creature')) return false;
  if (definition.cmc >= BOMB_CMC) return true;

  const biggest = biggestPower(state);
  return biggest !== null && powerOf(state, action.card) > biggest;
}

/**
 * Would this attack win the game if nothing blocked?
 *
 * "If unblocked" is the whole criterion, and it is the right one — the line goes
 * out at declare-attackers, before the player has said anything about blocks, so
 * assuming blocks would be reading a decision that has not happened yet.
 * Double strike counts twice; nothing else about combat is modelled here,
 * because a swing that only kills through trample maths is not the moment this
 * category is for.
 */
function isLethalSwing(state: GameState, action: Action, me: PlayerId): boolean {
  if (action.kind !== 'declareAttackers' || action.attackers.length === 0) return false;

  let damage = 0;
  for (const id of action.attackers) {
    if (!state.cards[id]) continue;
    const power = powerOf(state, id);
    if (power <= 0) continue;
    damage += hasKeyword(state, id, 'double strike') ? power * 2 : power;
  }

  const life = state.players[opponentOf(me)].life;
  return life > 0 && damage >= life;
}

const NO_EFFECTS: readonly Effect[] = [];

/** The effects an action is about to put on the stack. */
function effectsOf(state: GameState, action: Action): readonly Effect[] {
  if (action.kind !== 'castSpell' && action.kind !== 'activate') return NO_EFFECTS;

  const card = state.cards[action.card];
  const definition = card && state.defs[card.oracleId];
  if (!definition) return NO_EFFECTS;

  if (action.kind === 'castSpell') return definition.spellEffects;
  return definition.activated[action.abilityIndex]?.effects ?? NO_EFFECTS;
}

/**
 * Is he pointing removal at one of the player's creatures?
 *
 * Read off the chosen targets rather than off the resolution, because the line
 * has to go out with the cast — by the time the spell resolves the player has
 * had a whole priority window to watch it happen, and a magician who announces
 * the vanishing afterwards is a magician nobody books twice.
 *
 * Damage is measured against toughness *less damage already marked*, so the
 * second Shock at a wounded creature counts and the first one does not.
 */
function killsTheirCreature(state: GameState, action: Action, me: PlayerId): boolean {
  if (action.kind !== 'castSpell' && action.kind !== 'activate') return false;

  const targets = action.targets;
  if (!Array.isArray(targets) || targets.length === 0) return false;

  const effects = effectsOf(state, action);
  if (effects.length === 0) return false;

  const them = opponentOf(me);
  for (const id of targets) {
    const card = state.cards[id];
    if (!card || card.zone !== 'battlefield' || card.controller !== them) continue;
    if (!isCreature(state, id)) continue;

    const remaining = toughnessOf(state, id) - card.damage;
    for (const effect of effects) {
      if (effect.kind === 'destroy' || effect.kind === 'exile') return true;
      if (effect.kind === 'damage' && effect.amount >= remaining) return true;
      if (effect.kind === 'addCounter' && effect.counter === '-1/-1' && effect.count >= remaining) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Has his side of the table been swept?
 *
 * Nothing of his own left, at least two of theirs standing, and at least two
 * creatures of his in the graveyard to show there was something to sweep. The
 * graveyard clause is what separates "wiped" from "has not played a creature
 * yet", which are the same board and very different moments.
 */
function isWiped(state: GameState, me: PlayerId): boolean {
  if (creatureCount(state, me) > 0) return false;
  if (creatureCount(state, opponentOf(me)) < 2) return false;

  let buried = 0;
  for (const id of state.players[me].graveyard) {
    if (!state.cards[id]) continue;
    if (isCreature(state, id)) buried += 1;
    if (buried >= 2) return true;
  }
  return false;
}

/** Which moment, if any, this action is. First match in {@link CATEGORY_ORDER} wins. */
function categoryFor(state: GameState, action: Action, me: PlayerId): Category | null {
  for (const category of CATEGORY_ORDER) {
    switch (category) {
      case 'opening':
        if (state.turn <= OPENING_WINDOW && isFirstGesture(action)) return 'opening';
        break;
      case 'lethal':
        if (isLethalSwing(state, action, me)) return 'lethal';
        break;
      case 'bomb':
        if (isBomb(state, action, me)) return 'bomb';
        break;
      case 'kill':
        if (killsTheirCreature(state, action, me)) return 'kill';
        break;
      case 'wiped':
        if (isPlay(action) && isWiped(state, me)) return 'wiped';
        break;
      case 'lowLife': {
        const life = state.players[me].life;
        if (isPlay(action) && life > 0 && life < LOW_LIFE) return 'lowLife';
        break;
      }
      case 'dominant':
        if (
          isPlay(action) &&
          creatureCount(state, opponentOf(me)) === 0 &&
          creatureCount(state, me) >= 2
        ) {
          return 'dominant';
        }
        break;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shuffle bags
// ---------------------------------------------------------------------------

/** One category's worth of lines, dealt out in order and refilled when spent. */
interface Bag {
  /** Indices into the line list, in the order they will be dealt. */
  order: number[];
  /** How many of `order` have been dealt. */
  at: number;
  /** How many times this bag has been refilled — mixed into the next shuffle. */
  cycle: number;
  /** The last index dealt, so a refill never opens on the line that just closed. */
  last: number;
}

/**
 * What the performance remembers between calls.
 *
 * `speechFor` is a pure function of the state it is given plus this, and this is
 * derived entirely from seeded shuffles — so a game replayed from its seed and
 * its action log produces the same lines in the same places. It resets whenever
 * the seed changes or the turn counter goes backwards, which is what a rematch
 * looks like from in here.
 */
interface Memory {
  seed: number;
  /** The highest turn seen, used to notice a new game. */
  turn: number;
  bags: Map<string, Bag>;
  /** Moments already spoken for, so asking twice never re-draws. */
  said: Map<string, string>;
  /** The last turn each category fired on. */
  firedOn: Map<Category, number>;
  /** The turn a line last went out on, for the one-per-turn rule. */
  spokeOnTurn: number;
}

let memory: Memory | null = null;

function freshMemory(seed: number): Memory {
  return { seed, turn: 0, bags: new Map(), said: new Map(), firedOn: new Map(), spokeOnTurn: -1 };
}

/**
 * Forget everything he has said. Called by tests, and safe to call between
 * games; a new seed or a turn counter that went backwards does it automatically.
 */
export function resetSpeech(): void {
  memory = null;
}

function memoryFor(state: GameState): Memory {
  if (memory === null || memory.seed !== state.rngSeed || state.turn < memory.turn) {
    memory = freshMemory(state.rngSeed);
  }
  memory.turn = state.turn;
  return memory;
}

/** FNV-1a over a string, so a bag key becomes a seed. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Fold several numbers into one seed. */
function mix(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash = Math.imul(hash ^ (value >>> 0), 0x01000193) >>> 0;
    hash = (hash ^ (hash >>> 15)) >>> 0;
  }
  return hash >>> 0;
}

/** One seeded value in [0, 1) for a named decision. */
function roll(seed: number, key: string): number {
  return makeRng(mix(seed, hashString(key)))();
}

/**
 * A fresh deal of every index, shuffled from the seed.
 *
 * When the new order would open on the index the old one closed on, the first
 * two are swapped: back-to-back repeats across a refill are the one thing a
 * shuffle bag exists to prevent, and they are also the only repeat a listener
 * actually notices.
 */
function refill(count: number, seed: number, key: string, cycle: number, last: number): number[] {
  const indices = Array.from({ length: count }, (_unused, i) => i);
  const order = shuffle(indices, makeRng(mix(seed, hashString(key), cycle)));
  if (order.length > 1 && order[0] === last) {
    const first = order[0]!;
    order[0] = order[1]!;
    order[1] = first;
  }
  return order;
}

/** Deal the next line from a bag, refilling it when it runs dry. */
function drawLine(mem: Memory, key: string, lines: readonly string[]): string {
  let bag = mem.bags.get(key);
  if (!bag) {
    bag = { order: refill(lines.length, mem.seed, key, 0, -1), at: 0, cycle: 0, last: -1 };
    mem.bags.set(key, bag);
  }
  if (bag.at >= bag.order.length) {
    bag.cycle += 1;
    bag.order = refill(lines.length, mem.seed, key, bag.cycle, bag.last);
    bag.at = 0;
  }

  const index = bag.order[bag.at]!;
  bag.at += 1;
  bag.last = index;
  return lines[index]!;
}

// ---------------------------------------------------------------------------
// The one thing this module is for
// ---------------------------------------------------------------------------

/** What makes one moment distinguishable from the next. */
function signature(action: Action): string {
  switch (action.kind) {
    case 'playLand':
      return `land:${action.card}`;
    case 'castSpell':
      return `cast:${action.card}`;
    case 'activate':
      return `activate:${action.card}:${action.abilityIndex}`;
    case 'declareAttackers':
      return `attack:${[...action.attackers].sort().join(',')}`;
    case 'declareBlockers':
      return `block:${action.blocks.map((b) => `${b.blocker}>${b.attacker}`).sort().join(',')}`;
    default:
      return action.kind;
  }
}

/**
 * What the Magician says as he takes this action, or `null` for silence.
 *
 * `state` is the position *before* `action` is applied — the same state the
 * action was chosen from — so everything read here is what he can see as he
 * reaches for the card.
 *
 * The speaker is whoever holds priority, which for a bot turn and for a block
 * declaration during the player's turn is the bot either way. Nothing is
 * mutated: the action's own arrays are copied before they are sorted, and the
 * state is only ever read.
 *
 * Asking twice about the same moment gives the same answer, which is what lets
 * the UI call this without worrying about how often it does.
 */
export function speechFor(state: GameState, action: Action, tier: Tier): string | null {
  if (state.winner !== null) return null;

  const me = state.priority;
  const category = categoryFor(state, action, me);
  if (category === null) return null;

  const mem = memoryFor(state);
  const moment = `${tier}|${category}|${state.turn}|${signature(action)}`;
  const already = mem.said.get(moment);
  if (already !== undefined) return already;

  const lastFired = mem.firedOn.get(category);
  if (lastFired !== undefined && state.turn - lastFired < COOLDOWN[category]) return null;
  if (mem.spokeOnTurn === state.turn && !INTERRUPTS[category]) return null;
  if (roll(state.rngSeed, `${tier}|${category}|${state.turn}`) >= CHANCE[category]) return null;

  const line = drawLine(mem, `${tier}|${category}`, SPEECH_LINES[tier][category]);
  mem.said.set(moment, line);
  mem.firedOn.set(category, state.turn);
  mem.spokeOnTurn = state.turn;
  return line;
}
