/**
 * Resolves the card pool against Scryfall and emits src/data/cards.json.
 *
 * Runs at build time only. The game itself makes no network requests: everything a
 * match needs is in the committed JSON and the committed art.
 *
 * Scryfall's documented limits are respected here rather than approximated:
 *   /cards/collection is 2 requests/second, so batches are 500ms apart
 *   a User-Agent and Accept header are required on every request
 *   HTTP 429 means back off for 30s, not retry immediately
 *
 * Usage:  npm run pool          resolve and write
 *         npm run pool -- --dry report what would happen, write nothing
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL, toOracleId } from '../src/data/pool';
import { BEHAVIORS } from '../src/data/behaviors/index';
import { validateCard } from './validate';
import type { CardDef, CardType, Color, Keyword, ManaCost } from '../src/engine/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/data/cards.json');
const CACHE = resolve(HERE, '../.scryfall-cache.json');

const USER_AGENT = 'emteegee/0.1 (open-source beginner MTG demo)';
const COLLECTION_DELAY_MS = 550;
const BATCH = 75;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ScryfallCard {
  name: string;
  mana_cost?: string;
  cmc: number;
  colors?: string[];
  color_identity?: string[];
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  keywords?: string[];
  layout?: string;
  card_faces?: unknown[];
  artist?: string;
  set?: string;
  rarity?: string;
  image_uris?: Record<string, string>;
}

/** "{3}{W}{W}" -> { C: 3, W: 2 }. Hybrid and X costs are rejected upstream. */
export function parseManaCost(raw: string | undefined): ManaCost {
  const cost: ManaCost = {};
  if (!raw) return cost;
  for (const [, sym] of raw.matchAll(/\{([^}]+)\}/g)) {
    const s = sym!.toUpperCase();
    if (/^\d+$/.test(s)) cost.C = (cost.C ?? 0) + Number(s);
    else if (s === 'W' || s === 'U' || s === 'B' || s === 'R' || s === 'G') {
      cost[s as Color] = (cost[s as Color] ?? 0) + 1;
    } else {
      throw new Error(`unsupported mana symbol {${sym}} in "${raw}"`);
    }
  }
  return cost;
}

/** "Legendary Creature — Angel Warrior" -> { cardTypes, subtypes } */
export function parseTypeLine(line: string): { cardTypes: CardType[]; subtypes: string[] } {
  const [left = '', right = ''] = line.split(/\s+[—–-]\s+/);
  const known: CardType[] = ['creature', 'instant', 'sorcery', 'enchantment', 'artifact', 'land'];
  const lower = left.toLowerCase();
  return {
    cardTypes: known.filter(t => lower.includes(t)),
    subtypes: right ? right.split(/\s+/).filter(Boolean) : [],
  };
}

function parseKeywords(raw: string[] | undefined): Keyword[] {
  const known = new Set([
    'flying', 'reach', 'vigilance', 'haste', 'trample', 'first strike', 'double strike',
    'deathtouch', 'lifelink', 'menace', 'defender', 'ward', 'hexproof', 'flash',
  ]);
  return (raw ?? []).map(k => k.toLowerCase()).filter(k => known.has(k)) as Keyword[];
}

/** Basic lands are the one card whose behavior we can derive with certainty. */
function landMana(name: string): Color[] | undefined {
  const map: Record<string, Color> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  const c = map[name];
  return c ? [c] : undefined;
}

/**
 * Text that carries no rules meaning once keywords are accounted for. If what is
 * left is empty, the card is vanilla and needs no hand-authored behavior.
 */
function residualText(oracle: string, keywords: Keyword[]): string {
  let t = oracle.replace(/\([^)]*\)/g, '');
  for (const k of keywords) t = t.replace(new RegExp(`\\b${k}\\b`, 'gi'), '');
  return t.replace(/[,\s]+/g, ' ').trim();
}

async function fetchCollection(names: readonly string[]): Promise<{ found: ScryfallCard[]; missing: string[] }> {
  const found: ScryfallCard[] = [];
  const missing: string[] = [];

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    let attempt = 0;

    for (;;) {
      const res = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identifiers: batch.map(name => ({ name })) }),
      });

      if (res.status === 429) {
        if (++attempt > 2) throw new Error('Scryfall kept returning 429; stopping rather than hammering it');
        console.warn('  429 received, backing off 30s as Scryfall asks');
        await sleep(30_000);
        continue;
      }
      if (!res.ok) throw new Error(`Scryfall responded ${res.status} ${res.statusText}`);

      const body = (await res.json()) as { data: ScryfallCard[]; not_found?: Array<{ name?: string }> };
      found.push(...body.data);
      missing.push(...(body.not_found ?? []).map(m => m.name ?? '(unnamed)'));
      break;
    }

    console.log(`  resolved ${Math.min(i + BATCH, names.length)}/${names.length}`);
    if (i + BATCH < names.length) await sleep(COLLECTION_DELAY_MS);
  }

  return { found, missing };
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const cdn = process.argv.includes('--cdn');

  console.log(`emteegee card pool: ${POOL.length} cards`);

  let cards: ScryfallCard[];
  let missing: string[] = [];

  if (existsSync(CACHE)) {
    console.log('using .scryfall-cache.json (delete it to re-fetch)');
    cards = JSON.parse(readFileSync(CACHE, 'utf8')) as ScryfallCard[];
  } else {
    const result = await fetchCollection(POOL);
    cards = result.found;
    missing = result.missing;
    writeFileSync(CACHE, JSON.stringify(cards, null, 1));
  }

  const failures: string[] = [];
  if (missing.length) failures.push(...missing.map(m => `${m}: not found on Scryfall`));

  const defs: Record<string, CardDef> = {};

  for (const c of cards) {
    const check = validateCard(c);
    if (!check.ok) {
      failures.push(check.reason!);
      continue;
    }

    const oracleId = toOracleId(c.name);
    const { cardTypes, subtypes } = parseTypeLine(c.type_line);
    const keywords = parseKeywords(c.keywords);
    const behavior = BEHAVIORS[oracleId];
    const residual = residualText(c.oracle_text ?? '', keywords);
    const isLand = cardTypes.includes('land');

    // A card with meaningful text and no hand-authored behavior would be silently
    // misplayed as a vanilla card. That is exactly the failure this gate exists for.
    if (residual && !behavior && !isLand) {
      failures.push(`${c.name}: has rules text but no entry in src/data/behaviors/ — "${residual.slice(0, 80)}"`);
      continue;
    }

    let manaCost: ManaCost;
    try {
      manaCost = parseManaCost(c.mana_cost);
    } catch (err) {
      failures.push(`${c.name}: ${(err as Error).message}`);
      continue;
    }

    const images = c.image_uris ?? {};
    defs[oracleId] = {
      oracleId,
      name: c.name,
      manaCost,
      cmc: c.cmc,
      colors: (c.colors ?? []) as Color[],
      cardTypes,
      subtypes,
      ...(c.power !== undefined ? { power: Number(c.power) } : {}),
      ...(c.toughness !== undefined ? { toughness: Number(c.toughness) } : {}),
      oracleText: c.oracle_text ?? '',
      keywords,
      statics: behavior?.statics ?? [],
      triggers: behavior?.triggers ?? [],
      activated: behavior?.activated ?? [],
      spellEffects: behavior?.spellEffects ?? [],
      targets: behavior?.targets ?? [],
      ...(behavior?.wardCost ? { wardCost: behavior.wardCost } : {}),
      artist: c.artist ?? 'unknown',
      art: cdn ? (images.art_crop ?? '') : `art/${oracleId}-art.jpg`,
      image: cdn ? (images.normal ?? '') : `art/${oracleId}-card.jpg`,
      ...(landMana(c.name) ? { producesMana: landMana(c.name) } : {}),
    };
  }

  console.log(`\naccepted ${Object.keys(defs).length}`);
  if (failures.length) {
    console.error(`\nrejected ${failures.length}:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('\nThe pool must contain only cards the engine can play correctly.');
    console.error('Either author the behavior in src/data/behaviors.ts or remove the card from src/data/pool.ts.');
    process.exit(1);
  }

  if (dry) {
    console.log('\n--dry: nothing written');
    return;
  }

  writeFileSync(OUT, JSON.stringify(defs, null, 1));
  console.log(`wrote ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
