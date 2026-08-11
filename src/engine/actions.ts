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
 * 2. **Complete.** Every action a player could legally take right now appears in
 *    the list, including the combat declarations. That is what lets `isLegal` be
 *    a membership test rather than a parallel rulebook.
 * 3. **Sound.** Anything enumerated really is legal, targets included. A spell
 *    that needs a target it cannot legally choose is not offered at all, so the
 *    UI never has to explain a dead end after the fact.
 *
 * Completeness costs something in combat: the attacker declaration is the power
 * set of the eligible attackers, and the blocker declaration is every assignment
 * of blockers to attackers they may legally block. Both are exponential in the
 * board size by nature — there is no smaller complete answer — so callers with a
 * time budget (the Archmage tier) own their own cutoff. The game's boards are
 * small enough that this is measured in microseconds.
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
import { STACK_CAP } from './types';
import { canPay, cardsIn, hasKeyword, inst, isCreature, opponentOf, powerOf } from './state';

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

/**
 * Every legal way to fill in a spell's or ability's targets.
 *
 * An empty list means "this cannot legally be cast or activated at all" — one of
 * its required targets has nowhere to point. That is what keeps a removal spell
 * out of `legalActions` when the board is empty, rather than offering it and
 * failing at resolution.
 *
 * With no `TargetFilter`s the object either points at a player (both are legal
 * choices, as in Magic) or at nothing. With filters, the result is the cross
 * product of each filter's legal targets, with no card chosen twice — one object
 * cannot be two of a spell's targets.
 */
function targetSelections(
  state: GameState,
  filters: readonly TargetFilter[],
  effects: readonly Effect[],
  controller: PlayerId,
): TargetSelection[] {
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
 * Every subset of the eligible attackers, including the empty one — declining to
 * attack is a declaration too, and the player must be able to make it.
 *
 * Built by doubling rather than by bit masks so a wide board fails loudly on
 * memory instead of silently wrapping an integer to nothing.
 */
function attackActions(state: GameState, player: PlayerId): Action[] {
  if (state.phase !== 'declareAttackers') return [];
  if (state.active !== player) return [];

  const eligible = state.players[player].battlefield.filter((id) => canAttack(state, id));
  let subsets: CardId[][] = [[]];
  for (const id of eligible) {
    subsets = [...subsets, ...subsets.map((subset) => [...subset, id])];
  }
  return subsets.map((attackers) => ({ kind: 'declareAttackers', attackers }));
}

/** Untapped, on the battlefield, and not already committed to a block. */
function canBlock(state: GameState, id: CardId): boolean {
  const card = state.cards[id];
  if (!card || card.zone !== 'battlefield') return false;
  if (!isCreature(state, id)) return false;
  if (card.tapped) return false;
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

  const attackers = state.players[state.active].battlefield.filter(
    (id) => state.cards[id]?.attacking === true,
  );
  const blockers = state.players[player].battlefield.filter((id) => canBlock(state, id));

  let assignments: BlockAssignment[][] = [[]];
  for (const blocker of blockers) {
    const options = attackers.filter((attacker) => canBlockAttacker(state, blocker, attacker));
    if (options.length === 0) continue;
    assignments = [
      ...assignments,
      ...assignments.flatMap((partial) => options.map((attacker) => [...partial, { blocker, attacker }])),
    ];
  }

  return assignments
    .filter((blocks) => menaceSatisfied(state, blocks, attackers))
    .map((blocks) => ({ kind: 'declareBlockers', blocks }));
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
 */
export function legalActions(state: GameState): Action[] {
  if (state.winner !== null) return [];
  if (state.stack.length >= STACK_CAP) return [{ kind: 'pass' }];

  const player = state.priority;
  return [
    ...landActions(state, player),
    ...castActions(state, player),
    ...activateActions(state, player),
    ...attackActions(state, player),
    ...blockActions(state, player),
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
  return legalActions(state).some((candidate) => deepEqual(candidate, action));
}
