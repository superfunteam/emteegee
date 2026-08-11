import { describe, it, expect } from 'vitest';
import type { CardDef, OracleId } from '../../src/engine/types';
import { DECKS } from '../../src/decks';
import { deckSize, landCount, deckList } from '../../src/decks/types';
import { validateDeck, earlyPlays, burnProfile } from '../../src/decks/validate';
import cardsJson from '../../src/data/cards.json';

const CARDS = cardsJson as unknown as Record<OracleId, CardDef>;
const ALL = Object.values(DECKS);

describe('the deck slate', () => {
  it('has exactly six decks', () => {
    expect(ALL).toHaveLength(6);
  });

  it('covers three mono-color and three two-color decks', () => {
    expect(ALL.filter(d => d.colors.length === 1)).toHaveLength(3);
    expect(ALL.filter(d => d.colors.length === 2)).toHaveLength(3);
  });

  it('gives every deck a distinct id and name', () => {
    expect(new Set(ALL.map(d => d.id)).size).toBe(6);
    expect(new Set(ALL.map(d => d.name)).size).toBe(6);
  });

  it('gives every deck a distinct signature card', () => {
    expect(new Set(ALL.map(d => d.signature)).size).toBe(6);
  });
});

describe.each(ALL.map(d => [d.name, d] as const))('%s', (_name, deck) => {
  const report = validateDeck(deck, CARDS);

  it('passes deck legality with no errors', () => {
    expect(report.errors).toEqual([]);
  });

  it('is exactly 60 cards', () => {
    expect(deckSize(deck)).toBe(60);
  });

  it('runs 22 to 26 lands', () => {
    expect(landCount(deck)).toBeGreaterThanOrEqual(22);
    expect(landCount(deck)).toBeLessThanOrEqual(26);
  });

  it('stays inside its declared color identity', () => {
    expect(report.offColor).toEqual([]);
  });

  it('only uses cards from the validated pool', () => {
    for (const entry of deck.cards) expect(CARDS[entry.oracleId]).toBeDefined();
  });

  it('has enough early plays to function', () => {
    // Below this a deck spends its first three turns doing nothing, which is the
    // single most common reason a beginner puts a game down.
    expect(earlyPlays(deck)).toBeGreaterThanOrEqual(8);
  });

  it('expands to a 60-card list the engine can shuffle', () => {
    expect(deckList(deck)).toHaveLength(60);
  });

  it('has a signature card that is actually in the deck', () => {
    expect(deck.cards.some(c => c.oracleId === deck.signature)).toBe(true);
  });

  it('describes what it teaches', () => {
    expect(deck.teaches.length).toBeGreaterThan(2);
    expect(deck.theme.length).toBeGreaterThan(10);
  });
});

describe('Ember is capped per spec section 11', () => {
  const ember = ALL.find(d => d.id === 'ember');

  it('exists', () => {
    expect(ember).toBeDefined();
  });

  it('runs at most six burn spells', () => {
    // A mono-red deck that teaches reach is one card away from teaching
    // "you lose on turn four".
    expect(burnProfile(ember!).count).toBeLessThanOrEqual(6);
  });

  it('has no burn spell dealing more than three damage', () => {
    expect(burnProfile(ember!).largest).toBeLessThanOrEqual(3);
  });
});

describe('no mono-blue deck, deliberately', () => {
  it('has no deck whose only color is blue', () => {
    // Blue's beginner-facing cards teach "your turn did nothing". Blue appears in
    // Skies, where flying carries it. See spec section 11.
    expect(ALL.some(d => d.colors.length === 1 && d.colors[0] === 'U')).toBe(false);
  });

  it('still puts blue on the table somewhere', () => {
    expect(ALL.some(d => d.colors.includes('U'))).toBe(true);
  });
});
