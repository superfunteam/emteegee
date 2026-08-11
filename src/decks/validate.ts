/**
 * Deck legality.
 *
 * Checked in tests rather than at runtime — a deck that breaks these rules is a bug in
 * the repository, not something a player can cause. The point is that the six decks
 * stay honest as cards move in and out of the pool.
 */

import type { CardDef, Color, OracleId } from '../engine/types';
import type { Deck } from './types';
import { deckSize, landCount } from './types';

export interface DeckReport {
  errors: string[];
  /** Cards outside the deck's declared color identity. */
  offColor: OracleId[];
  size: number;
  lands: number;
  curve: Record<number, number>;
}

export function validateDeck(deck: Deck, cards: Record<OracleId, CardDef>): DeckReport {
  const errors: string[] = [];
  const offColor: OracleId[] = [];
  const curve: Record<number, number> = {};
  const identity = new Set<Color>(deck.colors);

  const size = deckSize(deck);
  if (size !== 60) errors.push(`${deck.name}: ${size} cards, must be exactly 60`);

  const lands = landCount(deck);
  if (lands < 22 || lands > 26) errors.push(`${deck.name}: ${lands} lands, must be 22-26`);

  const seen = new Set<OracleId>();
  for (const entry of deck.cards) {
    if (seen.has(entry.oracleId)) errors.push(`${deck.name}: ${entry.oracleId} listed twice`);
    seen.add(entry.oracleId);

    const card = cards[entry.oracleId];
    if (!card) {
      errors.push(`${deck.name}: ${entry.oracleId} is not in the validated card pool`);
      continue;
    }

    // Basic lands are the one card you may run more than four of.
    const isBasic = card.cardTypes.includes('land') && card.producesMana !== undefined;
    if (!isBasic && entry.count > 4) {
      errors.push(`${deck.name}: ${entry.count}x ${card.name}, limit is 4`);
    }
    if (entry.count < 1) errors.push(`${deck.name}: ${card.name} has a count of ${entry.count}`);

    if (entry.isLand !== card.cardTypes.includes('land')) {
      errors.push(`${deck.name}: ${card.name} isLand is ${entry.isLand} but the pool disagrees`);
    }
    if (entry.cmc !== card.cmc) {
      errors.push(`${deck.name}: ${card.name} cmc is ${entry.cmc} but the pool says ${card.cmc}`);
    }

    for (const color of card.colors) {
      if (!identity.has(color)) { offColor.push(entry.oracleId); break; }
    }

    if (!entry.isLand) curve[card.cmc] = (curve[card.cmc] ?? 0) + entry.count;
  }

  if (!cards[deck.signature]) {
    errors.push(`${deck.name}: signature card ${deck.signature} is not in the pool`);
  } else if (!seen.has(deck.signature)) {
    errors.push(`${deck.name}: signature card ${deck.signature} is not in the deck`);
  }

  return { errors, offColor, size, lands, curve };
}

/** Nonland cards at 2 mana or less — the difference between a deck and a pile. */
export function earlyPlays(deck: Deck): number {
  return deck.cards
    .filter(c => !c.isLand && c.cmc <= 2)
    .reduce((n, c) => n + c.count, 0);
}

/** Ember's cap from spec section 11, expressed so a test can assert it. */
export function burnProfile(deck: Deck): { count: number; largest: number } {
  const burn = deck.cards.filter(c => c.tags?.includes('burn'));
  return {
    count: burn.reduce((n, c) => n + c.count, 0),
    largest: burn.reduce((n, c) => Math.max(n, c.burnDamage ?? 0), 0),
  };
}
