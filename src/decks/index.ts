/**
 * The six decks.
 *
 * Three mono-color and three two-color, each built to teach exactly one idea. A
 * beginner should be able to pick any of them and come away understanding something
 * specific they did not know before.
 */

import type { Deck } from './types';
import { VALOR } from './valor';
import { EMBER } from './ember';
import { THICKET } from './thicket';
import { SKIES } from './skies';
import { NIGHTFALL } from './nightfall';
import { BLOOM } from './bloom';

export const DECKS: Record<string, Deck> = {
  valor: VALOR,
  ember: EMBER,
  thicket: THICKET,
  skies: SKIES,
  nightfall: NIGHTFALL,
  bloom: BLOOM,
};

export type { Deck, DeckEntry } from './types';
export { deckList, deckSize, landCount } from './types';
