/**
 * The legal-action generator: the single definition of "legal" in this game.
 *
 * The UI makes tappable exactly what `legalActions` enumerated, the bot searches
 * exactly what `legalActions` enumerated, and the tests assert against it. There
 * is no second opinion anywhere — `isLegal` is a membership check against this
 * same list, so the two cannot drift apart even in principle. If you ever find
 * yourself writing a rule check outside this file, that is the bug.
 *
 * Three properties hold throughout:
 *
 * 1. **Pure.** Nothing here reads a clock, a DOM, or `Math.random`, and no input
 *    state is ever mutated — every function only reads.
 * 2. **Complete, except where completeness is exponential.** Every action a
 *    player could take appears in the list — with the deliberate exceptions below.
 * 3. **Sound.** Anything enumerated really is legal, targets included. A spell
 *    that needs a target it cannot legally choose is not offered at all, so the
 *    UI never has to explain a dead end after the fact.
 *
 * ## The combat exception
 *
 * Combat declarations are set-valued. Enumerating every one of them is 2^n for
 * attackers and (1 + attackers)^blockers for blocks — eight against eight is
 * forty-three million assignments, walked on every call including from
 * `advancePhase`. The game would freeze exactly when the board got interesting.
 *
 * So for those two alone, legality is a **predicate** rather than a list:
 * {@link validateAttack} and {@link validateBlocks} are the definition, `isLegal`
 * consults them directly, and `legalActions` offers a bounded set of useful
 * candidates instead. The empty and all-in attack are always among them, so a bot
 * sampling candidates can never miss lethal; menace-satisfying pairs are always
 * among the blocks, or nothing could ever block a menace creature.
 *
 * ## The same exception, three more times
 *
 * Every other list-valued decision in the game is shaped identically — a London
 * keep is any N of seven in any order, a scry is any subset of what was looked
 * at, a damage assignment order is any permutation of the blockers — so each one
 * follows the same pattern rather than inventing a second one:
 * {@link validateKeepHand}, {@link validateScry} and {@link validateBlockerOrder}
 * are the definitions, `isLegal` consults them, and the generator offers a
 * bounded candidate list wide enough that a bot picking only from it still plays
 * sensibly and every card in hand can be reached by some offered move.
 */

import type {
  Action,
  ActivatedAbility,
  BlockAssignment,
  CardDef,
  CardId,
  CardType,
  Color,
  Effect,
  GameState,
  ManaCost,
  PlayerId,
  TargetFilter,
  TargetSelection,
  Zone,
} from './types';
import { MAX_MULLIGANS, STACK_CAP } from './types';
import { canPay, cantBlock, cardsIn, hasKeyword, inst, isCreature, opponentOf, powerOf } from './state';

/** Every mana symbol that can appear in a cost. */
const MANA_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

// ---------------------------------------------------------------------------
// Printed characteristics
// ---------------------------------------------------------------------------

interface Printed {
  cardTypes: readonly CardType[];
  subtypes: readonly string[];
  colors: readonly Color[];
  manaCost: ManaCost;
  wardCost: ManaCost | undefined;
  targets: readonly TargetFilter[];
  spellEffects: readonly Effect[];
  activated: readonly ActivatedAbility[];
}

const TOKEN_TYPES: readonly CardType[] = ['creature'];
const NOTHING: readonly never[] = [];

/**
 * What a card says about itself before the table changes anything.
 *
 * A def wins when one is registered; a token with no def falls back to its
 * `tokenSpec`, which is how a token can be targeted, blocked, and tapped for an
 * ability without `createToken` ever having to invent a `CardDef`.
 */
function printed(state: GameState, id: CardId): Printed {
  const card = inst(state, id);
  const found: CardDef | undefined = state.defs[card.oracleId];
  if (found) {
    return {
      cardTypes: found.cardTypes,
      subtypes: found.subtypes,
      colors: found.colors,
      manaCost: found.manaCost,
      wardCost: found.wardCost,
      targets: found.targets,
      spellEffects: found.spellEffects,
      activated: found.activated,
    };
  }
  if (card.tokenSpec) {
    return {
      cardTypes: TOKEN_TYPES,
      subtypes: card.tokenSpec.subtypes,
      colors: card.tokenSpec.colors,
      manaCost: {},
      wardCost: undefined,
      targets: NOTHING,
      spellEffects: NOTHING,
      activated: NOTHING,
    };
  }
  throw new Error(`printed: no card definition for "${card.oracleId}" (instance "${id}")`);
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/** Two costs paid together, e.g. a spell plus the ward tax on its target. */
function addCost(a: ManaCost, b: ManaCost): ManaCost {
  const out: ManaCost = { ...a };
  for (const key of MANA_KEYS) {
    const extra = b[key] ?? 0;
    if (extra > 0) out[key] = (out[key] ?? 0) + extra;
  }
  return out;
}

/**
 * What targeting this card costs on top of the spell or ability doing it.
 *
 * Ward only taxes an opponent: a player pointing at their own warded permanent
 * pays nothing. A warded card with no `wardCost` authored taxes nothing, which
 * keeps a data gap from quietly making a permanent untargetable.
 */
function wardTax(state: GameState, target: CardId, caster: PlayerId): ManaCost {
  const card = inst(state, target);
  if (card.controller === caster) return {};
  if (!hasKeyword(state, target, 'ward')) return {};
  return printed(state, target).wardCost ?? {};
}

/** The ward tax across a whole target selection. Player targets are never warded. */
function totalWardTax(state: GameState, selection: TargetSelection, caster: PlayerId): ManaCost {
  if (!Array.isArray(selection)) return {};
  let out: ManaCost = {};
  for (const id of selection) out = addCost(out, wardTax(state, id, caster));
  return out;
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * Does this card satisfy a filter written from `controller`'s point of view?
 *
 * `controller: 'you'` means whoever is doing the targeting, not player 0, so one
 * filter reads correctly for both sides. Only the fields the filter sets are
 * tested; an empty filter matches everything in its zone.
 */
function matchesFilter(
  state: GameState,
  id: CardId,
  filter: TargetFilter,
  controller: PlayerId,
): boolean {
  const card = state.cards[id];
  if (!card) return false;

  if (filter.zone !== undefined && card.zone !== filter.zone) return false;
  if (filter.controller === 'you' && card.controller !== controller) return false;
  if (filter.controller === 'opponent' && card.controller !== opponentOf(controller)) return false;

  const chars = printed(state, id);
  if (filter.cardTypes && !filter.cardTypes.some((t) => chars.cardTypes.includes(t))) return false;
  if (filter.subtypes && !filter.subtypes.some((t) => chars.subtypes.includes(t))) return false;
  if (filter.colors && !filter.colors.some((c) => chars.colors.includes(c))) return false;

  // Negated constraints are "none of these", not "not all of these". "Target
  // nonblack creature" is `notColors: ['B']`: a black-red creature is still
  // black and fails it, and a colorless one is not black and passes — neither of
  // which a whitelist of the other four colors gets right.
  if (filter.notColors && filter.notColors.some((c) => chars.colors.includes(c))) return false;
  if (filter.notCardTypes && filter.notCardTypes.some((t) => chars.cardTypes.includes(t))) return false;

  if (filter.minPower !== undefined || filter.maxPower !== undefined) {
    const power = powerOf(state, id);
    if (filter.minPower !== undefined && power < filter.minPower) return false;
    if (filter.maxPower !== undefined && power > filter.maxPower) return false;
  }

  if (filter.tapped !== undefined && card.tapped !== filter.tapped) return false;
  if (filter.attacking !== undefined && card.attacking !== filter.attacking) return false;
  if (filter.blocking !== undefined && (card.blocking !== undefined) !== filter.blocking) return false;
  return true;
}

/** Every card a filter could point at, before legality narrows it. */
function candidates(state: GameState, zone: Zone): CardId[] {
  if (zone === 'stack') return state.stack.map((object) => object.source);
  return [...cardsIn(state, 0, zone), ...cardsIn(state, 1, zone)];
}

/**
 * Everything `controller` may legally choose for this filter, right now.
 *
 * Three things narrow the field, in this order: the filter's own constraints,
 * hexproof (an opponent's hexproof permanent is out of reach; your own is not),
 * and ward (a target whose ward tax the player cannot pay is not offered).
 *
 * A filter with no `zone` reads the battlefield. Targeting is a thing you do to
 * permanents unless a card says otherwise, and defaulting to "every card in the
 * game" would make an under-specified filter point into libraries.
 */
export function legalTargets(state: GameState, filter: TargetFilter, controller: PlayerId): CardId[] {
  const out: CardId[] = [];
  for (const id of candidates(state, filter.zone ?? 'battlefield')) {
    if (out.includes(id)) continue;
    if (!state.cards[id]) continue;
    if (!matchesFilter(state, id, filter, controller)) continue;
    if (inst(state, id).controller !== controller && hasKeyword(state, id, 'hexproof')) continue;
    if (!canPay(state, controller, wardTax(state, id, controller))) continue;
    out.push(id);
  }
  return out;
}

/** Does anything in this effect list point at a player rather than a permanent? */
function targetsAPlayer(effects: readonly Effect[]): boolean {
  return effects.some((effect) => 'target' in effect && effect.target === 'player');
}

/** Does anything in this effect list read "any target"? */
function targetsAnything(effects: readonly Effect[]): boolean {
  return effects.some((effect) => 'target' in effect && effect.target === 'any');
}

/**
 * The creature half of "any target", for an object that named no filter of its
 * own. Every creature on either battlefield — the reading of a bare "any target".
 */
const ANY_TARGET_CREATURE: TargetFilter = { zone: 'battlefield', cardTypes: ['creature'] };

/**
 * Every legal way to fill in a spell's or ability's targets.
 *
 * An empty list means "this cannot legally be cast or activated at all" — one of
 * its required targets has nowhere to point. That is what keeps a removal spell
 * out of `legalActions` when the board is empty, rather than offering it and
 * failing at resolution.
 *
 * Three shapes of object, in the order they are decided:
 *
 * - **"Any target"** — an effect whose target is `'any'`. Magic's burn spell:
 *   one target, and it is a creature *or* a player, the caster's choice. Both
 *   halves are enumerated, so a Bolt offers every creature it may legally point
 *   at *and* each player's face. Offering only the creatures is what would make
 *   Lightning Bolt unplayable on an empty board, and it is the whole reason the
 *   member exists.
 * - **No `TargetFilter`s** — the object either points at a player (both are
 *   legal choices, as in Magic) or at nothing.
 * - **Filters** — the cross product of each filter's legal targets, with no card
 *   chosen twice, because one object cannot be two of a spell's targets.
 *
 * "Any target" is single-target by construction: `TargetSelection` is a list of
 * cards *or* one player, so "a creature and a player" has no representation. An
 * object that wants a second target alongside `'any'` therefore falls through to
 * the ordinary cross product and is offered its creatures only, rather than
 * being offered a player selection that would silently drop its other target.
 */
function targetSelections(
  state: GameState,
  filters: readonly TargetFilter[],
  effects: readonly Effect[],
  controller: PlayerId,
): TargetSelection[] {
  if (targetsAnything(effects) && filters.length <= 1) {
    const filter = filters[0] ?? ANY_TARGET_CREATURE;
    const creatures: TargetSelection[] = legalTargets(state, filter, controller).map((id) => [id]);
    return [...creatures, 'player0', 'player1'];
  }

  if (filters.length === 0) {
    return targetsAPlayer(effects) ? ['player0', 'player1'] : [null];
  }

  let combos: CardId[][] = [[]];
  for (const filter of filters) {
    const options = legalTargets(state, filter, controller);
    const next: CardId[][] = [];
    for (const combo of combos) {
      for (const id of options) {
        if (combo.includes(id)) continue;
        next.push([...combo, id]);
      }
    }
    if (next.length === 0) return [];
    combos = next;
  }
  return combos;
}

/**
 * The targets a triggered ability chooses as it goes on the stack.
 *
 * A trigger picks its targets at a different moment than the spell that created
 * it, and no `Action` carries the choice — nothing can ask a player where their
 * Bogardan Firefiend points. So the choice is made here and made
 * deterministically: the first legal option for each filter, in the stable order
 * {@link legalTargets} reports, never choosing one card twice.
 *
 * Legality is `legalTargets` and nothing else, so a trigger can no more reach a
 * hexproof permanent, or a ward its controller cannot pay, than a spell can.
 *
 * A filter with nothing to point at contributes nothing rather than aborting:
 * the ability still goes on the stack, and the effects that wanted a target
 * simply do nothing when it resolves.
 */
export function triggerTargets(
  state: GameState,
  filters: readonly TargetFilter[],
  controller: PlayerId,
): TargetSelection {
  const chosen: CardId[] = [];
  for (const filter of filters) {
    const options = legalTargets(state, filter, controller).filter((id) => !chosen.includes(id));
    if (options.length === 0) break;

    // Nothing can ask who a trigger points at — the Action union has no choice point —
    // so this picks for the controller. Scanning in battlefield order would hand a
    // death trigger the controller's *own* creature whenever they happen to be player
    // 0, which is a real misplay rather than a cosmetic one. Prefer an opponent's
    // permanent when the filter permits both.
    const opponentOwned = options.find((id) => state.cards[id]?.controller !== controller);
    chosen.push(opponentOwned ?? options[0]!);
  }
  return chosen.length > 0 ? chosen : null;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** A creature, sorcery, enchantment, or artifact without flash waits for a main phase. */
function isSorcerySpeed(state: GameState, card: CardId): boolean {
  if (printed(state, card).cardTypes.includes('instant')) return false;
  return !hasKeyword(state, card, 'flash');
}

/** Your own main phase, with nothing waiting to resolve. */
function sorceryTiming(state: GameState, player: PlayerId): boolean {
  if (state.active !== player) return false;
  if (state.stack.length !== 0) return false;
  return state.phase === 'main1' || state.phase === 'main2';
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

/**
 * Every legal way to cast this card right now, as a list of target selections.
 *
 * Empty means it cannot be cast: wrong zone, wrong moment, unaffordable, or
 * required targets with nowhere to point. Affordability is checked against the
 * spell's cost *plus* the ward tax of the targets that selection chose, so a
 * player who can pay for the spell or the ward but not both is not offered the
 * combination.
 */
function castSelections(state: GameState, card: CardId): TargetSelection[] {
  if (state.winner !== null) return [];
  if (state.stack.length >= STACK_CAP) return [];

  const instance = state.cards[card];
  if (!instance) return [];
  if (instance.zone !== 'hand') return [];

  const player = instance.controller;
  if (state.priority !== player) return [];
  if (!state.players[player].hand.includes(card)) return [];

  const chars = printed(state, card);
  if (chars.cardTypes.includes('land')) return [];
  if (isSorcerySpeed(state, card) && !sorceryTiming(state, player)) return [];

  return targetSelections(state, chars.targets, chars.spellEffects, player).filter((targets) =>
    canPay(state, player, addCost(chars.manaCost, totalWardTax(state, targets, player))),
  );
}

/**
 * Could this card be cast from its controller's hand right now?
 *
 * This is the same predicate `legalActions` casts by, so a card the UI dims is
 * exactly a card that produces no `castSpell` action.
 */
export function canCast(state: GameState, card: CardId): boolean {
  return castSelections(state, card).length > 0;
}

// ---------------------------------------------------------------------------
// Enumeration, one action kind at a time
// ---------------------------------------------------------------------------

function landActions(state: GameState, player: PlayerId): Action[] {
  if (state.active !== player) return [];
  if (state.stack.length !== 0) return [];
  if (state.phase !== 'main1' && state.phase !== 'main2') return [];
  if (state.players[player].landPlayedThisTurn) return [];

  const out: Action[] = [];
  for (const card of state.players[player].hand) {
    if (!state.cards[card]) continue;
    if (!printed(state, card).cardTypes.includes('land')) continue;
    out.push({ kind: 'playLand', card });
  }
  return out;
}

function castActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  for (const card of state.players[player].hand) {
    for (const targets of castSelections(state, card)) {
      out.push({ kind: 'castSpell', card, targets });
    }
  }
  return out;
}

/**
 * The non-mana half of an activation cost.
 *
 * `{T}` needs the permanent untapped, and a creature that arrived this turn
 * cannot pay it without haste — summoning sickness applies to tap abilities the
 * same way it applies to attacking. Sacrificing is always payable by something
 * already on the battlefield.
 */
function nonManaCostPayable(state: GameState, card: CardId, ability: ActivatedAbility): boolean {
  if (!ability.cost.tapSelf) return true;
  const instance = inst(state, card);
  if (instance.tapped) return false;
  if (isCreature(state, card) && instance.summonedThisTurn && !hasKeyword(state, card, 'haste')) {
    return false;
  }
  return true;
}

function activateActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  for (const card of state.players[player].battlefield) {
    if (!state.cards[card]) continue;
    const abilities = printed(state, card).activated;
    for (let abilityIndex = 0; abilityIndex < abilities.length; abilityIndex++) {
      const ability = abilities[abilityIndex]!;
      if (ability.sorcerySpeed && !sorceryTiming(state, player)) continue;
      if (!nonManaCostPayable(state, card, ability)) continue;

      const mana = ability.cost.mana ?? {};
      for (const targets of targetSelections(state, ability.targets, ability.effects, player)) {
        if (!canPay(state, player, addCost(mana, totalWardTax(state, targets, player)))) continue;
        out.push({ kind: 'activate', card, abilityIndex, targets });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combat declarations
// ---------------------------------------------------------------------------

/** Untapped, not a wall, and either settled or hasty. */
function canAttack(state: GameState, id: CardId): boolean {
  const card = state.cards[id];
  if (!card || card.zone !== 'battlefield') return false;
  if (!isCreature(state, id)) return false;
  if (card.tapped) return false;
  if (hasKeyword(state, id, 'defender')) return false;
  return !card.summonedThisTurn || hasKeyword(state, id, 'haste');
}

/**
 * Candidate attacks — NOT every subset.
 *
 * A combat declaration is set-valued, and enumerating every subset is 2^n: a board
 * of eight creatures is 256 actions, twelve is 4096, and the enumeration is walked
 * on every call including from `advancePhase`. Legality for these actions is a
 * predicate (`validateAttack`), not membership in a list, so this function's only
 * job is to offer a useful, bounded set of candidates to the bot and to the UI.
 *
 * The empty attack and the all-in attack are always present, so the bot can never
 * miss lethal by sampling.
 */
function attackActions(state: GameState, player: PlayerId): Action[] {
  if (state.phase !== 'declareAttackers') return [];
  if (state.active !== player) return [];
  // Declaring attackers is a turn-based action taken as the step begins, before any
  // player receives priority. With something still on the stack it is not yet time.
  if (state.stack.length !== 0) return [];

  const eligible = state.players[player].battlefield.filter((id) => canAttack(state, id));
  if (eligible.length === 0) return [{ kind: 'declareAttackers', attackers: [] }];

  const candidates: CardId[][] = [[], [...eligible]];
  // Each creature alone, so a player or bot can commit exactly one attacker.
  for (const id of eligible) candidates.push([id]);
  // All but one, which is how "attack with everything except my blocker" is reached.
  if (eligible.length > 2) {
    for (const id of eligible) candidates.push(eligible.filter((other) => other !== id));
  }

  return dedupeCardSets(candidates).map((attackers) => ({ kind: 'declareAttackers', attackers }));
}

/** Removes duplicate sets, comparing order-insensitively. */
function dedupeCardSets(sets: CardId[][]): CardId[][] {
  const seen = new Set<string>();
  const out: CardId[][] = [];
  for (const set of sets) {
    const key = [...set].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(set);
  }
  return out;
}

/**
 * Is this attack legal? Returns null when it is, or the reason when it is not.
 *
 * This is the definition `isLegal` and `combat.ts` both consult, so a declaration
 * the UI offers can never be one the engine throws on.
 */
export function validateAttack(state: GameState, attackers: readonly CardId[]): string | null {
  // The same two guards `legalActions` opens with. Without them `isLegal` accepts a
  // combat declaration in a finished game or while a scry is unanswered — states the
  // generator offers nothing in — and `reduce` performs it, because reduce trusts
  // isLegal completely. A predicate that is the definition of legal has to carry every
  // condition, not only the ones specific to combat.
  if (state.winner !== null) return 'the game is over';
  if (state.pendingScry) return 'a scry is waiting to be answered';
  if (state.phase !== 'declareAttackers') return 'not the declare attackers step';
  if (state.stack.length !== 0) return 'something is still on the stack';

  const seen = new Set<CardId>();
  for (const id of attackers) {
    if (seen.has(id)) return `${id} declared twice`;
    seen.add(id);
    const card = state.cards[id];
    if (!card) return `${id} does not exist`;
    if (card.controller !== state.active) return `${id} is not yours to attack with`;
    if (!canAttack(state, id)) return `${id} cannot attack`;
  }
  return null;
}

/**
 * Untapped, on the battlefield, not already committed to a block, and not a
 * creature that cannot block at all.
 *
 * The `cantBlock` static is checked here as well as in `combat.ts` on purpose:
 * this file is the single definition of legal, and a blocker enumerated here
 * that `declareBlockers` then refuses would be a move the UI offers and the
 * engine throws on.
 */
function canBlock(state: GameState, id: CardId): boolean {
  const card = state.cards[id];
  if (!card || card.zone !== 'battlefield') return false;
  if (!isCreature(state, id)) return false;
  if (card.tapped) return false;
  if (cantBlock(state, id)) return false;
  return card.blocking === undefined;
}

/** Evasion that a single blocker has to beat on its own: flying needs flying or reach. */
function canBlockAttacker(state: GameState, blocker: CardId, attacker: CardId): boolean {
  if (!hasKeyword(state, attacker, 'flying')) return true;
  return hasKeyword(state, blocker, 'flying') || hasKeyword(state, blocker, 'reach');
}

/** Menace is the evasion a blocker cannot beat alone: block with two, or with none. */
function menaceSatisfied(state: GameState, blocks: readonly BlockAssignment[], attackers: CardId[]): boolean {
  for (const attacker of attackers) {
    if (!hasKeyword(state, attacker, 'menace')) continue;
    const count = blocks.filter((block) => block.attacker === attacker).length;
    if (count === 1) return false;
  }
  return true;
}

/**
 * Every legal assignment of this player's blockers to the attackers, each
 * blocker blocking at most one attacker, including blocking with nobody.
 */
function blockActions(state: GameState, player: PlayerId): Action[] {
  if (state.phase !== 'declareBlockers') return [];
  if (player !== opponentOf(state.active)) return [];
  if (state.stack.length !== 0) return [];

  const attackers = state.players[state.active].battlefield.filter(
    (id) => state.cards[id]?.attacking === true,
  );
  const blockers = state.players[player].battlefield.filter((id) => canBlock(state, id));

  // The full assignment space is (1 + attackers)^blockers — eight against eight is
  // forty-three million. It is never enumerated. `validateBlocks` is the definition
  // of legal; these are candidates.
  const candidates: BlockAssignment[][] = [[]];

  // Every single legal block, so the UI has an affordance per pair and the bot has a
  // chump-block option against each attacker.
  for (const blocker of blockers) {
    for (const attacker of attackers) {
      if (!canBlockAttacker(state, blocker, attacker)) continue;
      const single: BlockAssignment[] = [{ blocker, attacker }];
      if (menaceSatisfied(state, single, attackers)) candidates.push(single);
    }
  }

  // Menace needs two blockers, so a single block against one is never legal and the
  // loop above filtered every one of them out. Without these pairs a menace attacker
  // could never be blocked from the candidate list at all — the human could still
  // build the block by tapping, but the bot picks from here, so it would simply never
  // block one.
  for (const attacker of attackers) {
    if (!hasKeyword(state, attacker, 'menace')) continue;
    const eligible = blockers.filter((b) => canBlockAttacker(state, b, attacker));
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        candidates.push([
          { blocker: eligible[i]!, attacker },
          { blocker: eligible[j]!, attacker },
        ]);
      }
    }
  }

  // One greedy "block everything you can", pairing each blocker with the first
  // attacker still unblocked, so declining to block is never the bot's only option
  // on a wide board.
  const greedy: BlockAssignment[] = [];
  const taken = new Set<CardId>();
  for (const blocker of blockers) {
    const attacker = attackers.find((a) => !taken.has(a) && canBlockAttacker(state, blocker, a));
    if (!attacker) continue;
    taken.add(attacker);
    greedy.push({ blocker, attacker });
  }
  // Drop any block the greedy pass left one short on a menace attacker, rather than
  // discarding the whole assignment for one bad pairing.
  const legalGreedy = greedy.filter(({ attacker }) => {
    if (!hasKeyword(state, attacker, 'menace')) return true;
    return greedy.filter((b) => b.attacker === attacker).length >= 2;
  });
  if (legalGreedy.length && menaceSatisfied(state, legalGreedy, attackers)) {
    candidates.push(legalGreedy);
  }

  return dedupeBlockSets(candidates).map((blocks) => ({ kind: 'declareBlockers', blocks }));
}

function dedupeBlockSets(sets: BlockAssignment[][]): BlockAssignment[][] {
  const seen = new Set<string>();
  const out: BlockAssignment[][] = [];
  for (const set of sets) {
    const key = set.map((b) => `${b.blocker}>${b.attacker}`).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(set);
  }
  return out;
}

/**
 * Is this set of blocks legal? Returns null when it is, or the reason when it is not.
 *
 * Menace is checked across the whole assignment rather than per blocker, which is the
 * only way to express "blocked by two or more".
 */
export function validateBlocks(state: GameState, blocks: readonly BlockAssignment[]): string | null {
  // The same two guards `legalActions` opens with. Without them `isLegal` accepts a
  // combat declaration in a finished game or while a scry is unanswered — states the
  // generator offers nothing in — and `reduce` performs it, because reduce trusts
  // isLegal completely. A predicate that is the definition of legal has to carry every
  // condition, not only the ones specific to combat.
  if (state.winner !== null) return 'the game is over';
  if (state.pendingScry) return 'a scry is waiting to be answered';
  if (state.phase !== 'declareBlockers') return 'not the declare blockers step';
  if (state.stack.length !== 0) return 'something is still on the stack';

  const defender = opponentOf(state.active);
  const attackers = state.players[state.active].battlefield.filter(
    (id) => state.cards[id]?.attacking === true,
  );

  const used = new Set<CardId>();
  for (const { blocker, attacker } of blocks) {
    if (used.has(blocker)) return `${blocker} cannot block twice`;
    used.add(blocker);

    const blockerCard = state.cards[blocker];
    if (!blockerCard) return `${blocker} does not exist`;
    if (blockerCard.controller !== defender) return `${blocker} is not yours to block with`;
    if (!canBlock(state, blocker)) return `${blocker} cannot block`;

    if (!attackers.includes(attacker)) return `${attacker} is not attacking`;
    if (!canBlockAttacker(state, blocker, attacker)) return `${blocker} cannot block ${attacker}`;
  }

  if (!menaceSatisfied(state, blocks, attackers)) return 'menace requires at least two blockers';
  return null;
}

// ---------------------------------------------------------------------------
// Blocker ordering
// ---------------------------------------------------------------------------

/**
 * How many orderings of one attacker's blockers the generator will offer.
 *
 * Four blockers is 24 orderings, which is every one of them; five is 120, and a
 * list that long is a list nobody is reading on a phone anyway. Past four this
 * degrades to a spread — the declaration order, its reverse, and each blocker
 * pulled to the front — for the same reason the combat declarations do:
 * {@link validateBlockerOrder} is the definition of legal, and these are
 * candidates.
 */
const MAX_BLOCKER_ORDERINGS = 24;

/**
 * The creatures blocking this attacker that are still in the fight.
 *
 * `blockedBy` can outlive the creatures in it — a blocker killed by a trick in
 * the priority window before damage leaves its id behind, and `combat.ts` skips
 * it when it assigns. Ordering a list with one live blocker in it decides
 * nothing, so this is what "blocked by two or more" is measured against.
 */
function liveBlockers(state: GameState, attacker: CardId): CardId[] {
  const card = state.cards[attacker];
  if (!card) return [];
  return card.blockedBy.filter((id) => {
    const blocker = state.cards[id];
    return blocker !== undefined && blocker.zone === 'battlefield' && blocker.blocking === attacker;
  });
}

/** Is this attacker blocked by enough creatures for the order to change anything? */
function needsOrdering(state: GameState, attacker: CardId): boolean {
  if (state.cards[attacker]?.damageOrderChosen) return false;
  const card = state.cards[attacker];
  if (!card || !card.attacking) return false;
  return liveBlockers(state, attacker).length >= 2;
}

/** Every ordering of a short list. */
function permutations(list: readonly CardId[]): CardId[][] {
  if (list.length <= 1) return [[...list]];
  const out: CardId[][] = [];
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([list[i]!, ...tail]);
  }
  return out;
}

/** Removes duplicate sequences, comparing order-sensitively. */
function dedupeSequences(sequences: CardId[][]): CardId[][] {
  const seen = new Set<string>();
  const out: CardId[][] = [];
  for (const sequence of sequences) {
    const key = sequence.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sequence);
  }
  return out;
}

/**
 * The orderings offered for one attacker, always including the order the blocks
 * were declared in — "leave it as it is" has to be a move the attacking player
 * can actually make, because making it is what passes the decision along.
 */
function orderCandidates(blockers: readonly CardId[]): CardId[][] {
  if (permutationCount(blockers.length) <= MAX_BLOCKER_ORDERINGS) {
    return dedupeSequences(permutations(blockers));
  }
  const out: CardId[][] = [[...blockers], [...blockers].reverse()];
  for (const id of blockers) out.push([id, ...blockers.filter((other) => other !== id)]);
  return dedupeSequences(out);
}

function permutationCount(n: number): number {
  let total = 1;
  for (let i = 2; i <= n; i++) total *= i;
  return total;
}

/**
 * Is this a legal damage assignment order? `null` when it is, the reason when
 * it is not.
 *
 * Three things make it legal, and the third is the one that stops the game from
 * looping. Ordering is offered in the step before damage, to the attacking
 * player, *while they hold priority* — and applying an order hands priority to
 * the defender (see `rules.ts`). So each attack is ordered once and the engine
 * cannot be walked back and forth between two arrangements forever, which is
 * exactly what a bot maximising an unchanged evaluation would otherwise do.
 *
 * Like the combat declarations, this is a predicate rather than membership in a
 * list: `legalActions` offers a bounded set of orderings and this is what
 * `isLegal` actually consults, so a player dragging blockers into any order at
 * all is answered correctly.
 */
export function validateBlockerOrder(
  state: GameState,
  attacker: CardId,
  order: readonly CardId[],
): string | null {
  if (state.winner !== null) return 'the game is over';
  if (state.phase !== 'firstStrikeDamage') return 'blockers are ordered in the step before damage';
  if (state.priority !== state.active) return 'only the attacking player orders blockers, and only once';

  const card = state.cards[attacker];
  if (!card) return `${attacker} does not exist`;
  if (card.controller !== state.active) return `${attacker} is not yours to order`;
  if (!needsOrdering(state, attacker)) return `${attacker} is not blocked by two or more creatures`;

  if (order.length !== card.blockedBy.length) return 'an order must list every blocker exactly once';
  const seen = new Set<CardId>();
  for (const id of order) {
    if (seen.has(id)) return `${id} is listed twice`;
    seen.add(id);
    if (!card.blockedBy.includes(id)) return `${id} is not blocking ${attacker}`;
  }
  return null;
}

/**
 * The ordering decisions the attacking player owes right now.
 *
 * Nothing at all in the common case: one blocker on an attacker has no order to
 * choose, and spec §9.4 says a stop where advancing is the only move is a stop
 * that does not happen. Two or more, and the attacker gets to say which one
 * takes lethal first — which is the difference between trading with the 1/1 and
 * trading with the 4/4.
 */
function orderActions(state: GameState, player: PlayerId): Action[] {
  if (state.phase !== 'firstStrikeDamage') return [];
  if (player !== state.active) return [];

  const out: Action[] = [];
  for (const attacker of state.players[player].battlefield) {
    if (!needsOrdering(state, attacker)) continue;
    for (const order of orderCandidates(inst(state, attacker).blockedBy)) {
      out.push({ kind: 'orderBlockers', attacker, order });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The opening hand
// ---------------------------------------------------------------------------

/**
 * The turn a game sits on while both players decide their opening hands.
 *
 * The mulligan happens before turn one, and "before turn one" is a number
 * `GameState.turn` can already hold. Spelling it as a new `Phase` member would
 * have been the other option and a worse one: `PHASE_ORDER` is the turn cycle
 * that `advancePhase` walks and wraps around, so a `'mulligan'` in it would come
 * back every single turn, and a `'mulligan'` deliberately left out of it would
 * make `PHASE_ORDER` stop being the list of phases. Turn zero is the pre-game,
 * it is unreachable from `advancePhase` (which only ever increments), and it
 * costs the type contract nothing.
 *
 * Whose decision it is, is `state.priority` — the field that already means
 * exactly that. The human decides first (spec §3 puts them on the play), so
 * priority walks 0, then 1, and the game begins when the second player keeps.
 */
export const MULLIGAN_TURN = 0;

/** Is the game still in the pre-game mulligan step? */
export function inMulligan(state: GameState): boolean {
  return state.turn === MULLIGAN_TURN;
}

/** How many cards a keep has to put on the bottom right now. */
function bottomCount(state: GameState, player: PlayerId): number {
  return Math.min(state.players[player].mulligansTaken, state.players[player].hand.length);
}

/**
 * Candidate keeps — NOT every combination.
 *
 * A London keep after two mulligans is any two of seven in any order, and the
 * general shape is exponential in the hand for the same reason a block
 * assignment is. `validateKeepHand` is the definition of legal, so this is a
 * useful bounded set: the cards held longest, the cards drawn last, and each
 * single card paired with enough others to make up the count — which is what
 * makes "put *that* one back" reachable from the list for every card in hand.
 */
function keepCandidates(state: GameState, player: PlayerId): CardId[][] {
  const hand = state.players[player].hand;
  const count = bottomCount(state, player);
  if (count === 0) return [[]];

  const sets: CardId[][] = [hand.slice(0, count), hand.slice(hand.length - count)];
  for (const card of hand) {
    sets.push([card, ...hand.filter((other) => other !== card).slice(0, count - 1)]);
  }
  return dedupeSequences(sets.filter((set) => set.length === count));
}

/**
 * Is this a legal keep? `null` when it is, the reason when it is not.
 *
 * London: you always draw seven and put back as many as you have mulliganed. A
 * keep is therefore not a choice of *how many* — only of which.
 */
export function validateKeepHand(state: GameState, toBottom: readonly CardId[]): string | null {
  if (state.winner !== null) return 'the game is over';
  if (!inMulligan(state)) return 'the opening hands have already been kept';

  const player = state.priority;
  const hand = state.players[player].hand;
  const required = bottomCount(state, player);
  if (toBottom.length !== required) {
    return `a London keep puts exactly ${required} card${required === 1 ? '' : 's'} on the bottom`;
  }

  const seen = new Set<CardId>();
  for (const id of toBottom) {
    if (seen.has(id)) return `${id} is listed twice`;
    seen.add(id);
    if (!hand.includes(id)) return `${id} is not in hand`;
  }
  return null;
}

/**
 * The two moves a player has before the game starts: take another seven, or
 * keep these and pay for the ones already taken.
 *
 * `pass` is deliberately absent. There is no advancing past this: the game does
 * not start until both hands are settled, and an opening hand nobody decided on
 * is not a state the engine can be in.
 */
function mulliganActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  if (state.players[player].mulligansTaken < MAX_MULLIGANS) out.push({ kind: 'mulligan' });
  for (const toBottom of keepCandidates(state, player)) out.push({ kind: 'keepHand', toBottom });
  return out;
}

// ---------------------------------------------------------------------------
// Scry
// ---------------------------------------------------------------------------

/**
 * Candidate scry decisions: all of it to the bottom, none of it, and each card
 * on its own.
 *
 * The full space is every subset in every order, and a scry 2 is small enough
 * that this covers all of it anyway. `validateScry` is the definition of legal,
 * so a player who wants some other split of a scry 3 gets it.
 */
function scryCandidates(cards: readonly CardId[]): CardId[][] {
  const sets: CardId[][] = [[], [...cards]];
  for (const id of cards) sets.push([id]);
  return dedupeSequences(sets);
}

/**
 * Is this a legal scry decision? `null` when it is, the reason when it is not.
 *
 * Only the cards actually looked at may be sent to the bottom, and none of them
 * twice. The rest stay on top: a scry never reorders what it did not see.
 */
export function validateScry(state: GameState, toBottom: readonly CardId[]): string | null {
  if (state.winner !== null) return 'the game is over';

  const pending = state.pendingScry;
  if (!pending) return 'no scry is waiting on a decision';
  if (state.priority !== pending.player) return 'the scry is not yours to decide';

  const seen = new Set<CardId>();
  for (const id of toBottom) {
    if (seen.has(id)) return `${id} is listed twice`;
    seen.add(id);
    if (!pending.cards.includes(id)) return `${id} is not one of the cards you are looking at`;
  }
  return null;
}

/**
 * The scry decision, and nothing else at all.
 *
 * A scry is a question the game has already asked: the cards are off the top of
 * the library and on `state.pendingScry`, and until their controller says where
 * they go there is no coherent position to cast a spell into. So while one is
 * pending this is the whole of what is legal — for the player who owes the
 * decision, and, since the other player cannot make it for them, nothing at all
 * for the other player.
 */
function scryActions(state: GameState, player: PlayerId): Action[] {
  const pending = state.pendingScry;
  if (!pending || pending.player !== player) return [];
  return scryCandidates(pending.cards).map((toBottom) => ({ kind: 'scryDecision', toBottom }));
}

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------

/** An untapped land of this player's that really does make mana. */
function tappableForMana(state: GameState, card: CardId): boolean {
  const instance = state.cards[card];
  if (!instance || instance.tapped) return false;
  const produces = state.defs[instance.oracleId]?.producesMana;
  return produces !== undefined && produces.length > 0;
}

/**
 * Tap a land for mana yourself.
 *
 * Casting auto-taps (spec §9.3) and almost nobody will ever use this, but the
 * lands are on screen behind a long-press and a player who taps one expects
 * mana. It is offered whenever the player holds priority, because floating mana
 * is exactly the thing you do *before* deciding what to spend it on.
 *
 * `rules.ts` treats it as a non-decision for pacing purposes, and it has to:
 * a stop is a phase where the player has a real choice, and "you control an
 * untapped land" is true in nearly every phase of the game.
 */
function manaActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  for (const card of state.players[player].battlefield) {
    if (!tappableForMana(state, card)) continue;
    out.push({ kind: 'tapLand', card });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Everything the player with priority may legally do right now.
 *
 * A finished game offers nothing at all, not even `pass` — there is no move left
 * to make. A full stack offers only `pass`: spec §3 caps the stack at three
 * objects, and the cap is a visible, explained rule rather than a silent
 * rejection, so the affordance disappears rather than misfiring.
 *
 * Two states answer the question with a single decision and nothing else, and
 * both are checked before anything ordinary is enumerated: the pre-game
 * mulligan, where the game has not started, and a pending scry, where the game
 * has already asked something and is waiting to be told.
 */
export function legalActions(state: GameState): Action[] {
  if (state.winner !== null) return [];

  const player = state.priority;
  if (inMulligan(state)) return mulliganActions(state, player);
  if (state.pendingScry) return scryActions(state, player);
  if (state.stack.length >= STACK_CAP) return [{ kind: 'pass' }];

  return [
    ...landActions(state, player),
    ...castActions(state, player),
    ...activateActions(state, player),
    ...manaActions(state, player),
    ...attackActions(state, player),
    ...blockActions(state, player),
    ...orderActions(state, player),
    { kind: 'pass' },
  ];
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Structural equality over the plain data an `Action` is made of. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

/**
 * Is this action one the engine would accept?
 *
 * Deliberately a membership check against {@link legalActions} rather than a
 * second set of rules. A parallel implementation would eventually disagree with
 * the generator, and the disagreement would show up as a move the UI offers and
 * the engine throws on. This cannot.
 */
export function isLegal(state: GameState, action: Action): boolean {
  // Combat declarations are set-valued: the space of legal ones is exponential in the
  // board size, so legality for them is a predicate rather than membership in a list.
  // `legalActions` still offers candidates; these validators are the definition.
  if (action.kind === 'declareAttackers') return validateAttack(state, action.attackers) === null;
  if (action.kind === 'declareBlockers') return validateBlocks(state, action.blocks) === null;

  // The same problem in three more places. A keep is any N of seven, a scry is any
  // subset of what was seen, and a damage assignment order is any permutation — all
  // of them lists the player builds a piece at a time, and none of them a list the
  // generator can hold in full.
  if (action.kind === 'keepHand') return validateKeepHand(state, action.toBottom) === null;
  if (action.kind === 'scryDecision') return validateScry(state, action.toBottom) === null;
  if (action.kind === 'orderBlockers') {
    return validateBlockerOrder(state, action.attacker, action.order) === null;
  }

  return legalActions(state).some((candidate) => deepEqual(candidate, action));
}
