/**
 * The deck contract.
 *
 * Six decks, each built to teach exactly one idea. The `teaches` field is not flavour
 * text — it is the design constraint the deck is checked against, and the reason a
 * beginner can pick any of them and come away understanding something specific.
 */

import type { Color, OracleId } from '../engine/types';

export interface DeckEntry {
  oracleId: OracleId;
  count: number;
  /** Denormalised from the card pool so deck tests can run without loading cards.json. */
  isLand: boolean;
  cmc: number;
  /**
   * Free-form labels the deck tests assert against. `burn` is load-bearing: spec
   * section 11 caps Ember at six burn spells, and that cap is an executable test.
   */
  tags?: string[];
  /** Damage dealt, for cards tagged `burn`. Also enforced by the Ember cap. */
  burnDamage?: number;
}

export interface Deck {
  id: string;
  name: string;
  colors: Color[];
  /** The card whose art represents the deck on the select screen. */
  signature: OracleId;
  /** One line, shown under the deck name. Written for someone who has never played. */
  theme: string;
  /** The single idea this deck exists to teach. */
  teaches: string;
  /** 1–3, shown as pips. Not difficulty of the deck's rules — difficulty of piloting it. */
  complexity: 1 | 2 | 3;
  cards: DeckEntry[];
}

export const deckSize = (deck: Deck): number =>
  deck.cards.reduce((n, c) => n + c.count, 0);

export const landCount = (deck: Deck): number =>
  deck.cards.filter(c => c.isLand).reduce((n, c) => n + c.count, 0);

/** Expands a deck into the flat list of oracle ids the engine shuffles. */
export function deckList(deck: Deck): OracleId[] {
  const out: OracleId[] = [];
  for (const entry of deck.cards) {
    for (let i = 0; i < entry.count; i++) out.push(entry.oracleId);
  }
  return out;
}
