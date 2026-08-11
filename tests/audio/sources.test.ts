/**
 * The sound kit fails quietly.
 *
 * A missing or misnamed sample does not throw — `kit.ts` swallows every playback and
 * decode error on purpose, because a silent game is playable and a crashed one is not.
 * That is the right call at runtime and exactly why it needs a test: without one, the
 * only symptom of a broken mapping is that the game gradually stops making noise and
 * nobody notices which event went missing.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFX_SOURCES, SFX_VARIANTS } from '../../src/audio/sources';

const HERE = dirname(fileURLToPath(import.meta.url));
const SFX_DIR = resolve(HERE, '../../public/sfx');

describe('every mapped sound exists on disk', () => {
  it.each(Object.keys(SFX_SOURCES))('%s.ogg is present', name => {
    expect(existsSync(resolve(SFX_DIR, `${name}.ogg`))).toBe(true);
  });

  it('ships nothing the game never asks for', () => {
    const shipped = readdirSync(SFX_DIR)
      .filter(f => f.endsWith('.ogg'))
      .map(f => f.replace(/\.ogg$/, ''));
    const mapped = new Set(Object.keys(SFX_SOURCES));
    expect(shipped.filter(name => !mapped.has(name))).toEqual([]);
  });
});

describe('the variant table points at real sounds', () => {
  it('every variant names a mapped sound', () => {
    for (const [group, variants] of Object.entries(SFX_VARIANTS)) {
      for (const variant of variants) {
        expect(Object.keys(SFX_SOURCES), `${group} -> ${variant}`).toContain(variant);
      }
    }
  });

  it('gives every varied sound at least two options', () => {
    // A one-entry variant group is a rotation that never rotates, which is the same
    // mechanical repetition the group exists to avoid.
    for (const [group, variants] of Object.entries(SFX_VARIANTS)) {
      expect(variants.length, group).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the mapping keeps the distinctions the design depends on', () => {
  it('damage to a player and damage to a creature use different instruments', () => {
    // Spec section 10: during an eight-attacker swing you should be able to hear
    // whether you are losing creatures or life without looking at the screen.
    const player = SFX_SOURCES['damage-player'];
    const creature = SFX_SOURCES['damage-creature'];
    expect(player).toBeDefined();
    expect(creature).toBeDefined();
    expect(player!.file).not.toBe(creature!.file);
    expect(player!.file).toMatch(/Bell/i);
    expect(creature!.file).toMatch(/Metal/i);
  });

  it('covers every sound the animator asks for by name', () => {
    // These are the literals in ui/animator.ts. A rename there that is not made here
    // would silently drop that event's sound.
    const asked = [
      'draw', 'play', 'cast', 'resolve', 'countered', 'tap', 'untap', 'attack',
      'block', 'die', 'token', 'counter-add', 'scry', 'phase', 'win', 'lose',
      'damage-player', 'damage-creature', 'life-gain', 'button', 'blip', 'select',
      'illegal', 'zoom-open', 'zoom-close', 'shuffle', 'mulligan',
    ];
    const known = new Set([...Object.keys(SFX_SOURCES), ...Object.keys(SFX_VARIANTS)]);
    expect(asked.filter(name => !known.has(name))).toEqual([]);
  });
});
