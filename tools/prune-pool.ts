/**
 * Removes from the pool every card the build gate rejects.
 *
 * The gate in `build-pool.ts` reports what it cannot accept and stops. Acting on that
 * report by hand means editing a long list and getting the names exactly right, which
 * is the kind of chore that quietly stops happening. This does it mechanically and
 * prints what it took out and why, so the diff is reviewable.
 *
 * Deliberately a separate command rather than a flag on the build: a tool that
 * rewrites your source should be something you asked for, not a side effect of
 * running the build.
 *
 * Usage:  npx tsx tools/prune-pool.ts          show what would go, change nothing
 *         npx tsx tools/prune-pool.ts --write  actually remove them
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL, toOracleId } from '../src/data/pool';
import { BEHAVIORS } from '../src/data/behaviors/index';
import { validateCard } from './validate';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_FILE = resolve(HERE, '../src/data/pool.ts');
const CACHE = resolve(HERE, '../.scryfall-cache.json');

interface Cached {
  name: string;
  oracle_text?: string;
  keywords?: string[];
  type_line: string;
  layout?: string;
  card_faces?: unknown[];
}

/** Same rule the build uses: text left over once keywords are accounted for. */
function residualText(oracle: string, keywords: string[]): string {
  let t = oracle.replace(/\([^)]*\)/g, '');
  for (const k of keywords) t = t.replace(new RegExp(`\\b${k}\\b`, 'gi'), '');
  return t.replace(/[,\s]+/g, ' ').trim();
}

function main(): void {
  const write = process.argv.includes('--write');

  if (!existsSync(CACHE)) {
    console.error('.scryfall-cache.json is missing. Run `npm run pool` first.');
    process.exit(1);
  }

  const cards = JSON.parse(readFileSync(CACHE, 'utf8')) as Cached[];
  const byName = new Map(cards.map(c => [c.name, c]));

  const doomed: Array<{ name: string; why: string }> = [];

  for (const name of POOL) {
    const card = byName.get(name);
    if (!card) {
      doomed.push({ name, why: 'not found on Scryfall' });
      continue;
    }

    const check = validateCard(card);
    if (!check.ok) {
      doomed.push({ name, why: check.reason!.replace(`${name}: `, '') });
      continue;
    }

    const isLand = card.type_line.toLowerCase().includes('land');
    const keywords = (card.keywords ?? []).map(k => k.toLowerCase());
    const residual = residualText(card.oracle_text ?? '', keywords);

    if (residual && !BEHAVIORS[toOracleId(name)] && !isLand) {
      doomed.push({ name, why: `no behavior authored — "${residual.slice(0, 60)}"` });
    }
  }

  if (!doomed.length) {
    console.log(`the pool is clean: all ${POOL.length} cards build`);
    return;
  }

  console.log(`${doomed.length} of ${POOL.length} cards cannot be built:\n`);
  for (const { name, why } of doomed) console.log(`  ${name.padEnd(26)} ${why}`);

  if (!write) {
    console.log('\nnothing changed. re-run with --write to remove them from src/data/pool.ts');
    return;
  }

  const names = new Set(doomed.map(d => d.name));
  const source = readFileSync(POOL_FILE, 'utf8');

  const kept: string[] = [];
  const lines = source.split('\n').filter(line => {
    const match = /^\s*"(.+)",\s*$/.exec(line);
    if (!match) return true;
    if (names.has(match[1]!)) return false;
    kept.push(match[1]!);
    return true;
  });

  // Group headings carry their own counts, and a stale count is worse than none.
  const rewritten = lines
    .map(line => line.replace(/^(\s*\/\/ [A-Za-z]+) \(\d+\)$/, '$1'))
    .join('\n')
    .replace(/^ \* \d+ cards\./m, ` * ${kept.length} cards.`);

  writeFileSync(POOL_FILE, rewritten);
  console.log(`\nremoved ${doomed.length}, ${kept.length} cards remain in src/data/pool.ts`);
  console.log('run `npm run pool` to confirm it builds clean now');
}

main();
