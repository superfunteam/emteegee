/**
 * Build-time gate on the card pool.
 *
 * The promise of this game is that every card in it can be played correctly by an
 * engine with a deliberately small vocabulary. That promise rots the moment someone
 * adds a card whose text the engine cannot honor, so the build fails loudly instead.
 *
 * This runs against raw Scryfall card objects, before they become CardDefs.
 */

import { ALL_KEYWORDS } from '../src/engine/types';

/** The subset of a Scryfall card this gate needs. */
export interface ScryfallLike {
  name: string;
  oracle_text?: string;
  keywords?: string[];
  type_line: string;
  layout?: string;
  card_faces?: unknown[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const ALLOWED_TYPES = ['creature', 'instant', 'sorcery', 'enchantment', 'artifact', 'land'];

/** Types that exist in Magic but not in this game. */
const FORBIDDEN_TYPES = ['planeswalker', 'battle', 'saga', 'vanguard', 'conspiracy', 'phenomenon', 'plane', 'scheme', 'dungeon'];

/** Layouts whose card faces this engine has no representation for. */
const FORBIDDEN_LAYOUTS = [
  'transform', 'modal_dfc', 'meld', 'split', 'flip', 'adventure',
  'leveler', 'class', 'saga', 'prototype', 'reversible_card', 'battle',
];

/**
 * Scryfall reports some mechanics as "keywords" that this engine models elsewhere:
 * `Enchant` is how an aura attaches (a StaticAbility of kind 'aura') and `Scry` is a
 * member of the effect vocabulary. Both are in scope, so neither belongs in the
 * Keyword union — but both must be accepted here.
 */
const NON_KEYWORD_MECHANICS = ['enchant', 'scry'];

const IMPLEMENTED_KEYWORDS = new Set<string>([
  ...ALL_KEYWORDS.map(k => k.toLowerCase()),
  ...NON_KEYWORD_MECHANICS,
]);

/**
 * Oracle-text patterns for mechanics outside the spec's scope. Each carries the
 * human-readable reason so a build failure tells you *why*, not just *that*.
 */
const FORBIDDEN_TEXT: Array<{ re: RegExp; why: string }> = [
  { re: /\bgraveyard\b/i, why: 'graveyard as a resource is out of scope (no recursion, no flashback)' },
  { re: /search your library/i, why: 'tutoring is out of scope' },
  { re: /protection from/i, why: 'protection is out of scope' },
  { re: /\bregenerate\b/i, why: 'regeneration is out of scope' },
  { re: /\bmill\b|\bmills\b/i, why: 'milling is out of scope' },
  { re: /you win the game|you lose the game/i, why: 'alternate win conditions are out of scope' },
  { re: /whenever .{0,40}\btriggers\b/i, why: 'a trigger triggering off another trigger is forbidden by the loop guard' },
  { re: /\bcascade\b|\bstorm\b|\bsuspend\b/i, why: 'cast-chaining mechanics are out of scope' },
  { re: /\bcopy\b.{0,30}\bspell\b/i, why: 'spell copying is out of scope' },
  { re: /extra turn/i, why: 'extra turns are out of scope' },
  { re: /\bexert\b|\bconvoke\b|\bimprovise\b|\bdelve\b/i, why: 'alternate cost mechanics are out of scope' },
  { re: /shuffle your library/i, why: 'library manipulation beyond scry is out of scope' },
  { re: /\bmonarch\b|\binitiative\b|\bday\b \/ \bnight\b/i, why: 'designated-player mechanics are out of scope' },
  { re: /\bcan't be countered\b/i, why: 'replacement effects are out of scope' },
  { re: /\bphase out\b|\bphases out\b/i, why: 'phasing is out of scope' },
  { re: /\bmorph\b|\bmanifest\b|\bdisguise\b/i, why: 'face-down permanents are out of scope' },

  // These read as ordinary Magic but have no member in the effect vocabulary.
  // Without them the gate lets through cards the engine would silently misplay,
  // which is worse than rejecting them.
  { re: /\bfights?\b/i, why: 'fight has no effect-vocabulary member' },
  { re: /gains? control of|gain control of/i, why: 'changing control has no effect-vocabulary member' },
  { re: /\bwhere X is\b|\bX damage\b|\bX target\b/i, why: 'X costs are not representable in ManaCost' },
  { re: /equal to the number of|equal to its power|equal to that creature/i, why: 'dynamic characteristics are not modelled' },
  { re: /attacks? each combat if able|attacks? this turn if able/i, why: 'attack requirements are not modelled' },
  { re: /can'?t be blocked/i, why: 'blocking restrictions beyond flying, reach and menace are not modelled' },
  // The aura static grants power, toughness and keywords. An aura that forbids
  // attacking or blocking (Pacifism) needs a vocabulary member that does not exist yet.
  { re: /can'?t attack/i, why: 'auras that forbid attacking need an aura restriction the vocabulary lacks' },
  { re: /\bexchange\b/i, why: 'exchanging objects has no effect-vocabulary member' },
  { re: /\bcascade\b|\bconvoke\b|\bkicker\b|\bbuyback\b|\bentwine\b/i, why: 'alternate and additional costs are out of scope' },
  { re: /\bdouble\b.{0,20}\b(life|damage|power)\b/i, why: 'doubling effects are not modelled' },
  { re: /for each\b/i, why: 'per-object scaling is not modelled' },
  { re: /\bchoose one\b|\bchoose two\b/i, why: 'modal spells are not modelled' },
  { re: /at the beginning of (each|the next)/i, why: 'delayed and per-player triggers are not modelled' },
  { re: /\bsacrifice\b.{0,30}\bunless\b/i, why: 'unless-clauses are not modelled' },
];

/**
 * Strip text that cannot change how this engine plays a card, so it can't trip a
 * forbidden pattern. Two sources of false positives:
 *
 *  - Riders like "It can't be regenerated." are no-ops in a game with no regeneration,
 *    but they appear on half the classic removal spells (Terror, Wrath of God).
 *  - Scryfall includes parenthetical reminder text, which restates mechanics in prose
 *    and is not itself a rule.
 */
export function stripInertText(oracle: string): string {
  return oracle
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(it|they|that creature|those creatures) can'?t be regenerated\.?/gi, '');
}

export function validateCard(card: ScryfallLike): ValidationResult {
  const typeLine = card.type_line.toLowerCase();

  for (const bad of FORBIDDEN_TYPES) {
    if (typeLine.includes(bad)) {
      return { ok: false, reason: `${card.name}: card type "${bad}" is not implemented` };
    }
  }

  const hasAllowedType = ALLOWED_TYPES.some(t => typeLine.includes(t));
  if (!hasAllowedType) {
    return { ok: false, reason: `${card.name}: no implemented card type in "${card.type_line}"` };
  }

  if (card.layout && FORBIDDEN_LAYOUTS.includes(card.layout)) {
    return { ok: false, reason: `${card.name}: layout "${card.layout}" is not implemented` };
  }

  if (card.card_faces && card.card_faces.length > 1) {
    return { ok: false, reason: `${card.name}: multi-faced cards are not implemented` };
  }

  for (const kw of card.keywords ?? []) {
    if (!IMPLEMENTED_KEYWORDS.has(kw.toLowerCase())) {
      return { ok: false, reason: `${card.name}: keyword "${kw}" is not implemented` };
    }
  }

  const text = stripInertText(card.oracle_text ?? '');
  for (const { re, why } of FORBIDDEN_TEXT) {
    if (re.test(text)) {
      return { ok: false, reason: `${card.name}: ${why}` };
    }
  }

  return { ok: true };
}
