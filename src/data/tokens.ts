/**
 * Creature tokens and their art.
 *
 * Tokens are real cards on Scryfall, so they get real illustrations like everything
 * else rather than a generated placeholder — a Goblin token that looks like a Goblin
 * is worth the two extra downloads.
 *
 * The Scryfall ids below are from the Foundations token set (tfdn), chosen because
 * those printings are plain: no reminder text, no set-specific rider, modern frame,
 * and art that sits comfortably next to the rest of the pool.
 *
 * `tools/fetch-art.ts` reads TOKEN_ART and writes public/art/token-<key>-art.jpg.
 */

import type { TokenSpec } from '../engine/types';

/** key -> Scryfall card id for the printing whose art we ship. */
export const TOKEN_ART: Record<string, string> = {
  soldier: 'd093322e-a717-4e2d-8199-fa560792bcf6',
  goblin: '70f8a1de-cd4c-4afa-bf03-0245d375d42e',
};

export const tokenArtPath = (key: string): string => `art/token-${key}-art.jpg`;

/** The 1/1 white Soldier every white token maker in this pool produces. */
export const SOLDIER_TOKEN: TokenSpec = {
  name: 'Soldier',
  power: 1,
  toughness: 1,
  colors: ['W'],
  subtypes: ['Soldier'],
  keywords: [],
  art: tokenArtPath('soldier'),
};

/** Krenko's Command makes two of these. */
export const GOBLIN_TOKEN: TokenSpec = {
  name: 'Goblin',
  power: 1,
  toughness: 1,
  colors: ['R'],
  subtypes: ['Goblin'],
  keywords: [],
  art: tokenArtPath('goblin'),
};
