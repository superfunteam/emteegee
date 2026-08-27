/**
 * The effects layer: short-lived ghosts that travel between real places on the table.
 *
 * A card leaving the fan for the mana row, a spell sliding onto the stack, a bolt
 * crossing the table — none of these are state. They exist to answer the one question
 * the instant repaint cannot: "where did that thing GO?" The renderer paints the new
 * home immediately; a ghost draws the line from the old home to the new one.
 *
 * Everything here animates with the Web Animations API rather than CSS classes,
 * because a ghost's start and end points are measured rects, not stylesheet values.
 * That also means the reduced-motion kill switch in table.css cannot reach them —
 * so callers must gate on the animator's `instant` flag, and every spawn here is
 * written on the assumption that the caller already did.
 *
 * Ghosts remove themselves. Nothing else may hold a reference to one.
 */

import { el } from './dom';

export interface Point {
  x: number;
  y: number;
}

export const centerOf = (rect: DOMRect): Point => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/** A rect of a chosen size centred on a point — for destinations that are a place
 *  rather than a box, like "into the card backs" or "onto the library counter". */
export const rectAt = (point: Point, width: number, height: number): DOMRect =>
  new DOMRect(point.x - width / 2, point.y - height / 2, width, height);

export const createFxLayer = (): HTMLElement => el('div.fx', { 'aria-hidden': 'true' });

/** A ghost that shows a card face. */
export const ghostCard = (src: string): HTMLElement =>
  el('div.fx__card', {}, el<HTMLImageElement>('img', { src, alt: '' }));

/** A ghost that shows the back of a card — for things whose face is hidden. */
export const ghostBack = (): HTMLElement => el('div.fx__cardback');

interface FlightOpts {
  from: DOMRect;
  to: DOMRect;
  duration: number;
  /** Midpoint lift in px. A small arc reads as a toss; zero reads as a slide. */
  arc?: number;
  /** Opacity on arrival. Ghosts landing in a real home should fade into it. */
  settleOpacity?: number;
  /**
   * The angle the thing was sitting at when it left — a card in the fan is rotated.
   * The ghost starts at that angle and straightens as it flies, so departure is
   * seamless instead of the card snapping upright the frame it takes off.
   */
  fromRotation?: number;
  onArrive?: () => void;
}

/**
 * Fly `content` from one rect to another, scaling to match the destination's width.
 *
 * Scale is uniform (by width) rather than stretching to the destination box, so a
 * card keeps its proportions as it shrinks into a pill or grows into a tile. The
 * flight is centre-to-centre, which is what makes the uniform scale safe.
 */
export function fly(layer: HTMLElement, content: HTMLElement, opts: FlightOpts): void {
  const { from, to } = opts;
  const ghost = el('div.fx__ghost', {}, content);
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  layer.append(ghost);

  const scale = to.width / Math.max(1, from.width);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const arc = opts.arc ?? 0;
  const settle = opts.settleOpacity ?? 1;
  const rot = opts.fromRotation ?? 0;

  run(
    ghost,
    [
      { transform: `translate(0px, 0px) rotate(${rot}deg) scale(1)`, opacity: 1 },
      {
        transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) rotate(${rot / 2}deg) scale(${(1 + scale) / 2})`,
        opacity: 1,
        offset: 0.55,
      },
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${scale})`, opacity: settle },
    ],
    opts.duration,
    opts.onArrive,
  );
}

/** Shrink, grey out and fade where it stands — for things that stop existing
 *  somewhere with no visible home to travel to. */
export function dissolve(layer: HTMLElement, content: HTMLElement, from: DOMRect, duration: number): void {
  const ghost = el('div.fx__ghost', {}, content);
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  layer.append(ghost);

  run(
    ghost,
    [
      { transform: 'scale(1) rotate(0deg)', opacity: 1, filter: 'none' },
      {
        transform: 'scale(0.6) rotate(-7deg) translateY(10px)',
        opacity: 0,
        filter: 'grayscale(1) brightness(0.6)',
      },
    ],
    duration,
  );
}

/**
 * Jab an existing element toward a point and back — the peck of an attack.
 *
 * `composite: 'add'` layers the jab on top of whatever transform the element already
 * carries (a lunge, a tap rotation), so a creature strikes from wherever it visually
 * is instead of snapping to its untransformed position first.
 *
 * Returns the time to contact in ms, so the caller can land the impact on the beat
 * the ghost's fist does.
 */
export function peck(node: HTMLElement, toward: Point, duration: number): number {
  const rect = node.getBoundingClientRect();
  const from = centerOf(rect);
  let dx = toward.x - from.x;
  let dy = toward.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  // Reach half the gap, capped: contact is claimed by the impact ring at the target,
  // so the striker only needs to visibly commit in the right direction.
  const reach = Math.min(distance * 0.5, 96);
  dx = (dx / distance) * reach;
  dy = (dy / distance) * reach;

  try {
    node.animate(
      [
        { transform: 'translate(0px, 0px)' },
        {
          transform: `translate(${dx}px, ${dy}px)`,
          offset: 0.38,
          easing: 'cubic-bezier(0.6, 0, 0.9, 0.6)',
        },
        { transform: 'translate(0px, 0px)' },
      ],
      { duration, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', composite: 'add' },
    );
  } catch {
    return 0;
  }
  return Math.round(duration * 0.38);
}

/** A projectile for damage with no body behind it — a burn spell crossing the table. */
export function bolt(layer: HTMLElement, from: Point, to: Point, duration: number, onArrive?: () => void): void {
  const ghost = el('div.fx__bolt');
  ghost.style.left = `${from.x}px`;
  ghost.style.top = `${from.y}px`;
  layer.append(ghost);

  run(
    ghost,
    [
      { transform: 'translate(0px, 0px) scale(0.6)', opacity: 0.9 },
      { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(1)`, opacity: 1 },
    ],
    duration,
    onArrive,
  );
}

/** The ring that marks the exact point something was hit. */
export function impactRing(layer: HTMLElement, at: Point): void {
  const ring = el('div.fx__ring');
  ring.style.left = `${at.x}px`;
  ring.style.top = `${at.y}px`;
  layer.append(ring);
  // The ring animates via CSS so the skin owns its color; the timer is the cleanup
  // (animationend is unreliable if the reduced-motion rule zeroed the duration).
  setTimeout(() => ring.remove(), 500);
}

/** Run a WAAPI animation and guarantee the ghost leaves the tree afterwards, even
 *  if the animation is cancelled or the API is unavailable. */
function run(ghost: HTMLElement, keyframes: Keyframe[], duration: number, onArrive?: () => void): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    ghost.remove();
    onArrive?.();
  };

  try {
    const animation = ghost.animate(keyframes, {
      duration,
      easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)',
      fill: 'forwards',
    });
    animation.onfinish = finish;
    animation.oncancel = finish;
  } catch {
    finish();
    return;
  }
  // Belt and braces: a detached document or paused timeline must not leak ghosts.
  setTimeout(finish, duration + 600);
}
