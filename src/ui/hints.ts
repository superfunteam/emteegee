/**
 * Contextual hints.
 *
 * No tutorial, no modal, no "next" button. The first time a concept comes up, one line
 * appears near where it matters and then never again. Teaching at the moment of need
 * costs the player nothing; a tutorial up front costs them the thing they came for.
 *
 * Every hint is dismissible by ignoring it, which is the only dismissal a player
 * actually performs.
 */

const STORAGE_KEY = 'emteegee.hints';

/** Written to be read in about two seconds, mid-game, on a phone. */
const HINTS: Record<string, string> = {
  // Flow
  attacking: 'Tap your creatures to send them in, then <b>Attack</b>. Tapped creatures cannot attack.',
  blocking: 'Tap one of your creatures, then tap the attacker it should block.',
  targeting: 'Tap what this spell should point at.',
  mana: 'Lands make mana. Tap the mana row to see them.',
  landDrop: 'One land per turn — it is the most important play you will make.',

  // Keywords, shown the first time one appears on the board
  flying: '<b>Flying:</b> only creatures with flying or reach can block this.',
  reach: '<b>Reach:</b> this can block creatures with flying.',
  trample: '<b>Trample:</b> damage past the blockers spills onto the player.',
  deathtouch: '<b>Deathtouch:</b> any damage from this is lethal, whatever the size.',
  lifelink: '<b>Lifelink:</b> damage this deals also gains you that much life.',
  vigilance: '<b>Vigilance:</b> this attacks without tapping, so it can still block.',
  haste: '<b>Haste:</b> this can attack the turn it arrives.',
  menace: '<b>Menace:</b> this cannot be blocked by just one creature.',
  'first strike': '<b>First strike:</b> this deals damage before creatures without it.',
  'double strike': '<b>Double strike:</b> this deals damage twice — before, and again with everyone else.',
  defender: '<b>Defender:</b> this cannot attack, but it blocks well.',
  hexproof: '<b>Hexproof:</b> your opponent cannot target this.',
  ward: '<b>Ward:</b> targeting this costs your opponent extra.',
  flash: '<b>Flash:</b> you can play this any time, even on their turn.',

  // Board concepts
  summoningSick: 'A creature cannot attack the turn it arrives, unless it has haste.',
  stackFull: 'The stack is full — three things are already waiting to happen.',
  stackOrder: 'The <b>last</b> thing added happens <b>first</b>. Their answer resolves before your spell.',
  firstBlock: 'Blocking costs you nothing. An unblocked attacker hits you for its full power.',
};

function seen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persist(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Private browsing: hints simply show again next session.
  }
}

/**
 * Returns a hint the first time its key comes up, and null forever after.
 * Asking is what marks it seen — callers do not need a second call.
 */
export function hintFor(key: string): string | null {
  const text = HINTS[key];
  if (!text) return null;

  const already = seen();
  if (already.has(key)) return null;

  already.add(key);
  persist(already);
  return text;
}

/** Marks a hint seen without showing it. */
export function markHintSeen(key: string): void {
  const already = seen();
  already.add(key);
  persist(already);
}

/** "Show hints again" in settings. */
export function resetHints(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to reset.
  }
}

export function hintsRemaining(): number {
  return Object.keys(HINTS).length - seen().size;
}
