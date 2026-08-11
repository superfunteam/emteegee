/**
 * Sound playback.
 *
 * Web Audio rather than <audio> elements, for three reasons that all matter on a
 * phone: the same sound can overlap itself (eight attackers, eight impacts), latency
 * is low enough that a tap feels connected to its sound, and one gain node mutes
 * everything without touching each source.
 *
 * Sound is never load-bearing. Every failure path here is swallowed — a browser that
 * blocks audio, a missing file, a decode error — because a silent game is playable and
 * a crashed one is not.
 */

import { SFX_SOURCES, SFX_VARIANTS } from './sources';

export type SoundName = keyof typeof SFX_SOURCES | keyof typeof SFX_VARIANTS;

const STORAGE_KEY = 'emteegee.audio';

interface AudioPrefs {
  muted: boolean;
  volume: number;
}

function loadPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
      return {
        muted: parsed.muted ?? false,
        volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : 0.7,
      };
    }
  } catch {
    // A blocked or corrupt localStorage is not a reason to fail.
  }
  return { muted: false, volume: 0.7 };
}

class SoundKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private prefs: AudioPrefs = loadPrefs();
  private loading: Promise<void> | null = null;
  /** Seeded per call site rather than globally, so variant choice never repeats twice. */
  private lastVariant = new Map<string, string>();

  get muted(): boolean {
    return this.prefs.muted;
  }

  get volume(): number {
    return this.prefs.volume;
  }

  /**
   * Browsers refuse to start an AudioContext until the user has interacted with the
   * page, so this is called from the first real tap rather than at load.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.prefs.muted ? 0 : this.prefs.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  /**
   * Fetch and decode everything up front. Called during deck select so the first card
   * play is never silent, and awaited by nobody — a slow network delays sound, not the
   * game.
   */
  preload(base = 'sfx'): Promise<void> {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const names = Object.keys(SFX_SOURCES);
      await Promise.all(names.map(async name => {
        try {
          const res = await fetch(`${base}/${name}.ogg`);
          if (!res.ok) return;
          const bytes = await res.arrayBuffer();
          this.unlock();
          if (!this.ctx) return;
          this.buffers.set(name, await this.ctx.decodeAudioData(bytes));
        } catch {
          // One missing sound must not stop the other thirty-five.
        }
      }));
    })();

    return this.loading;
  }

  /**
   * `rate` shifts pitch, which is how one impact sample covers a range of severities —
   * a 1/1 trading and a 7/7 connecting should not sound identical.
   */
  play(name: SoundName, opts: { gain?: number; rate?: number } = {}): void {
    if (this.prefs.muted) return;
    this.unlock();
    if (!this.ctx || !this.master) return;

    const resolved = this.resolveVariant(String(name));
    const buffer = this.buffers.get(resolved);
    if (!buffer) return;

    try {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = opts.rate ?? 1;

      if (opts.gain !== undefined && opts.gain !== 1) {
        const node = this.ctx.createGain();
        node.gain.value = opts.gain;
        source.connect(node).connect(this.master);
      } else {
        source.connect(this.master);
      }

      source.start();
      // BufferSource is single-use; letting it go out of scope after onended is what
      // keeps a long match from accumulating dead nodes.
      source.onended = () => source.disconnect();
    } catch {
      // Playback failure is never worth surfacing.
    }
  }

  /** Picks a variant, never the same one twice in a row. */
  private resolveVariant(name: string): string {
    const variants = SFX_VARIANTS[name];
    if (!variants || variants.length === 0) return name;

    const previous = this.lastVariant.get(name);
    const eligible = variants.length > 1 ? variants.filter(v => v !== previous) : variants;
    const chosen = eligible[Math.floor(Math.random() * eligible.length)] ?? variants[0]!;
    this.lastVariant.set(name, chosen);
    return chosen;
  }

  setMuted(muted: boolean): void {
    this.prefs.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.prefs.volume;
    this.persist();
  }

  setVolume(volume: number): void {
    this.prefs.volume = Math.min(1, Math.max(0, volume));
    if (this.master && !this.prefs.muted) this.master.gain.value = this.prefs.volume;
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      // Private browsing. The setting simply will not survive a reload.
    }
  }
}

export const sound = new SoundKit();
