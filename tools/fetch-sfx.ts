/**
 * Assembles the sound kit into public/sfx/.
 *
 * Sources are five Kenney packs, all CC0 — no attribution required, though the README
 * credits them anyway. Rather than shipping 389 files we copy only the ~40 the game
 * actually plays, renamed to what they mean here ("damage-player" rather than
 * "impactBell_heavy_002") so the mapping is legible at the call site.
 *
 * Usage:  npm run sfx           download, unpack, copy, report
 *         npm run sfx -- --keep leave the downloaded zips in place for inspection
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SFX_SOURCES } from '../src/audio/sources';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../public/sfx');
const WORK = resolve(HERE, '../.sfx-work');

const USER_AGENT = 'emteegee/0.1 (open-source beginner MTG demo)';

/**
 * Kenney serves each pack from a content-hashed path, so these URLs pin an exact
 * version. If one 404s, the pack was re-released — find the new link on the asset page
 * rather than switching to a mirror.
 */
const PACKS: Record<string, string> = {
  'interface-sounds': 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
  'impact-sounds': 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',
  'ui-audio': 'https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip',
  'rpg-audio': 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip',
  'casino-audio': 'https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip',
};

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

/** Kenney's folder layout differs per pack, so find each file by name anywhere inside. */
function indexByBasename(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ogg')) found.set(entry.name, path);
    }
  };
  walk(root);
  return found;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');

  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  const index = new Map<string, Map<string, string>>();

  for (const [pack, url] of Object.entries(PACKS)) {
    const zip = resolve(WORK, `${pack}.zip`);
    const dir = resolve(WORK, pack);
    if (!existsSync(dir)) {
      console.log(`fetching ${pack}`);
      if (!existsSync(zip)) await download(url, zip);
      mkdirSync(dir, { recursive: true });
      execFileSync('unzip', ['-qo', zip, '-d', dir]);
    }
    index.set(pack, indexByBasename(dir));
  }

  const missing: string[] = [];
  let copied = 0;

  for (const [name, source] of Object.entries(SFX_SOURCES)) {
    const packIndex = index.get(source.pack);
    const from = packIndex?.get(source.file);
    if (!from) {
      missing.push(`${name}: ${source.pack}/${source.file}`);
      continue;
    }
    copyFileSync(from, resolve(OUT, `${name}.ogg`));
    copied++;
  }

  if (missing.length) {
    console.error(`\n${missing.length} sounds not found in their pack:`);
    for (const m of missing) console.error(`  ${m}`);
    console.error('\nA pack was probably re-released with renamed files. Check the pack contents.');
    process.exit(1);
  }

  if (!keep) rmSync(WORK, { recursive: true, force: true });

  const files = readdirSync(OUT);
  const bytes = files.reduce((n, f) => n + statSync(resolve(OUT, f)).size, 0);
  console.log(`\npublic/sfx: ${copied} sounds, ${(bytes / 1024).toFixed(0)}KB`);
  console.log(`(from ${Object.keys(PACKS).length} Kenney packs, all CC0)`);
  console.log(files.map(f => basename(f, '.ogg')).join(', '));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
