/**
 * Downloads and downscales the card art bundle into public/art/.
 *
 * Images come from *.scryfall.io, which unlike the API has no rate limit — but there
 * is no reason to be rude about it, so downloads run at a modest concurrency and
 * anything already on disk is skipped. Re-running is cheap and idempotent.
 *
 * Two images per card:
 *   <id>-art.jpg    art_crop, 420px wide — the frameless tile on the battlefield
 *   <id>-card.jpg   normal,   488px wide — the real card, shown on tap and read
 *
 * Usage:  npm run art            download anything missing
 *         npm run art -- --force re-download everything
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { CardDef } from '../src/engine/types';
import { TOKEN_ART } from '../src/data/tokens';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARDS = resolve(HERE, '../src/data/cards.json');
const CACHE = resolve(HERE, '../.scryfall-cache.json');
const ART_DIR = resolve(HERE, '../public/art');

const USER_AGENT = 'emteegee/0.1 (open-source beginner MTG demo)';
const CONCURRENCY = 6;

/*
 * The card face is NOT downscaled below Scryfall's `normal`, which is 488px wide.
 *
 * It used to be capped at 320, which `sips -Z` applies to the longest side — so a
 * portrait card came out 229px across and the reader was upscaling it by a third. Rules
 * text at that resolution is a smudge, and rules text is the entire reason a beginner
 * opens a card. The art crop stays small: it is a 74px tile that is never read.
 */
const WIDTHS = { art: 420, card: 488 } as const;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Job {
  oracleId: string;
  kind: 'art' | 'card';
  url: string;
  path: string;
}

/** macOS ships sips; on other platforms downscaling is skipped with a warning. */
let downscaleWorks: boolean | null = null;
function downscale(path: string, width: number): void {
  if (downscaleWorks === false) return;
  try {
    execFileSync('sips', ['-Z', String(width), path, '--out', path], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '62', path, '--out', path], { stdio: 'ignore' });
    downscaleWorks = true;
  } catch {
    if (downscaleWorks === null) {
      console.warn('  sips unavailable — shipping full-size images (bundle will be larger)');
    }
    downscaleWorks = false;
  }
}

async function download(job: Job): Promise<number> {
  const res = await fetch(job.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${job.oracleId} ${job.kind}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(job.path, buf);
  downscale(job.path, WIDTHS[job.kind]);
  return statSync(job.path).size;
}

async function runPool(jobs: Job[]): Promise<{ bytes: number; failures: string[] }> {
  let index = 0;
  let bytes = 0;
  const failures: string[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = index++;
      const job = jobs[i];
      if (!job) return;
      try {
        bytes += await download(job);
      } catch (err) {
        failures.push((err as Error).message);
      }
      if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${jobs.length}`);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { bytes, failures };
}

/**
 * Tokens are real Scryfall cards, so they get real art. They are not in the pool (you
 * never hold one), so their image urls are resolved by id rather than from the cache.
 * `/cards/<id>` is in the 10/second bucket; 100ms between calls is polite and plenty.
 */
async function tokenJobs(force: boolean): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const [key, id] of Object.entries(TOKEN_ART)) {
    const path = resolve(ART_DIR, `token-${key}-art.jpg`);
    if (!force && existsSync(path)) continue;

    const res = await fetch(`https://api.scryfall.com/cards/${id}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`token "${key}" (${id}): ${res.status} ${res.statusText}`);
    const card = (await res.json()) as { image_uris?: Record<string, string> };
    const url = card.image_uris?.art_crop;
    if (!url) throw new Error(`token "${key}" (${id}) has no art_crop image`);

    jobs.push({ oracleId: `token-${key}`, kind: 'art', url, path });
    await sleep(110);
  }
  return jobs;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  if (!existsSync(CARDS)) {
    console.error('src/data/cards.json is missing. Run `npm run pool` first.');
    process.exit(1);
  }
  if (!existsSync(CACHE)) {
    console.error('.scryfall-cache.json is missing — it holds the source image URLs. Run `npm run pool` first.');
    process.exit(1);
  }

  mkdirSync(ART_DIR, { recursive: true });

  const defs = JSON.parse(readFileSync(CARDS, 'utf8')) as Record<string, CardDef>;
  const raw = JSON.parse(readFileSync(CACHE, 'utf8')) as Array<{ name: string; image_uris?: Record<string, string> }>;
  const byName = new Map(raw.map(c => [c.name, c]));

  const jobs: Job[] = [];
  const missingSource: string[] = [];

  for (const def of Object.values(defs)) {
    const src = byName.get(def.name);
    const uris = src?.image_uris;
    if (!uris?.art_crop || !uris?.normal) {
      missingSource.push(def.name);
      continue;
    }
    for (const [kind, uri] of [['art', uris.art_crop], ['card', uris.normal]] as const) {
      const path = resolve(ART_DIR, `${def.oracleId}-${kind}.jpg`);
      if (!force && existsSync(path)) continue;
      jobs.push({ oracleId: def.oracleId, kind, url: uri, path });
    }
  }

  if (missingSource.length) {
    console.warn(`no image source for ${missingSource.length} cards: ${missingSource.slice(0, 5).join(', ')}`);
  }

  jobs.push(...(await tokenJobs(force)));

  if (!jobs.length) {
    console.log('art bundle is already complete');
    reportTotal();
    return;
  }

  console.log(`downloading ${jobs.length} images for ${Object.keys(defs).length} cards + ${Object.keys(TOKEN_ART).length} tokens`);
  const { failures } = await runPool(jobs);
  if (failures.length) {
    console.error(`\n${failures.length} downloads failed:`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
    process.exit(1);
  }
  reportTotal();
}

function reportTotal(): void {
  const files = readdirSync(ART_DIR);
  const bytes = files.reduce((n, f) => n + statSync(resolve(ART_DIR, f)).size, 0);
  console.log(`\npublic/art: ${files.length} files, ${(bytes / 1048576).toFixed(1)}MB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
