/**
 * Turns engine events into a timeline.
 *
 * The engine emits what happened; this decides how long each thing takes to show and
 * what it sounds like. Nothing else in the UI calls setTimeout — if timing lives in
 * one place it can be reasoned about, fast-forwarded, and switched off wholesale for
 * reduced motion.
 *
 * The contract with the engine is one-directional: events flow in, nothing flows back.
 * The animator can never desync state because it cannot change it.
 */

import type { GameEvent } from '../engine/types';
import { sound } from '../audio/kit';
import { prefersReducedMotion } from './dom';

/** Per spec section 9.6: no single beat exceeds 600ms, and a full combat sequence
 *  finishes within 2.5s. These are the numbers that enforce it. */
const DURATION: Record<GameEvent['type'], number> = {
  DRAW: 220,
  PLAY: 320,
  CAST: 300,
  RESOLVE: 180,
  COUNTERED: 300,
  TAP: 110,
  UNTAP: 90,
  ATTACK: 380,
  BLOCK: 220,
  DAMAGE: 260,
  DIE: 420,
  LIFE_CHANGE: 300,
  COUNTER_ADD: 200,
  TOKEN_CREATE: 300,
  ZONE_CHANGE: 160,
  SCRY: 400,
  PHASE: 60,
  TRIGGER: 240,
  WIN: 600,
};

/**
 * Beats that carry no information on their own and would only pad the sequence. The
 * engine still emits them — the UI just does not stop for them.
 */
const INSTANT: ReadonlySet<GameEvent['type']> = new Set(['ZONE_CHANGE']);

export type EventHandler = (event: GameEvent) => void;

export class Animator {
  private queue: GameEvent[] = [];
  private running = false;
  private skipping = false;
  private render: EventHandler;
  private onDrain: (() => void) | null = null;

  constructor(render: EventHandler) {
    this.render = render;
  }

  get busy(): boolean {
    return this.running;
  }

  enqueue(events: readonly GameEvent[]): void {
    this.queue.push(...events);
    if (!this.running) void this.drain();
  }

  /** Tapping during a sequence should feel like impatience, not like a lost input:
   *  the remaining beats play at once instead of being dropped or queued behind. */
  skip(): void {
    if (this.running) this.skipping = true;
  }

  /** Resolves once the queue is empty. The session awaits this before handing
   *  priority back, so the player never acts against a half-rendered board. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise(resolve => {
      this.onDrain = resolve;
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    const reduced = prefersReducedMotion();

    while (this.queue.length) {
      const event = this.queue.shift()!;
      this.render(event);
      this.playSound(event);

      if (reduced || this.skipping || INSTANT.has(event.type)) continue;
      await wait(DURATION[event.type]);
    }

    this.running = false;
    this.skipping = false;
    const done = this.onDrain;
    this.onDrain = null;
    done?.();
  }

  private playSound(event: GameEvent): void {
    switch (event.type) {
      case 'DRAW': sound.play('draw'); break;
      case 'PLAY': sound.play('play'); break;
      case 'CAST': sound.play('cast'); break;
      case 'RESOLVE': sound.play('resolve'); break;
      case 'COUNTERED': sound.play('countered'); break;
      case 'TAP': sound.play('tap', { gain: 0.5 }); break;
      case 'UNTAP': sound.play('untap', { gain: 0.4 }); break;
      case 'ATTACK': sound.play('attack'); break;
      case 'BLOCK': sound.play('block'); break;
      case 'DIE': sound.play('die'); break;
      case 'TOKEN_CREATE': sound.play('token'); break;
      case 'COUNTER_ADD': sound.play('counter-add', { gain: 0.6 }); break;
      case 'SCRY': sound.play('scry'); break;
      case 'PHASE': sound.play('phase', { gain: 0.22 }); break;
      case 'WIN': sound.play('win'); break;

      case 'DAMAGE':
        // A bell for the player, metal for a creature. Pitch tracks severity, so a
        // 1/1 trading and a 7/7 connecting do not sound the same.
        if (event.isPlayer) {
          sound.play('damage-player', { rate: 1 - Math.min(event.amount, 8) * 0.03 });
        } else {
          sound.play('damage-creature', { rate: 1.12 - Math.min(event.amount, 8) * 0.04 });
        }
        break;

      case 'LIFE_CHANGE':
        if (event.to > event.from) sound.play('life-gain', { gain: 0.7 });
        break;

      default:
        break;
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Exposed for the animator's tests, which assert the spec's timing budget. */
export const TIMING = { DURATION, INSTANT } as const;
