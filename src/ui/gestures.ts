/**
 * Touch gestures.
 *
 * Pointer Events rather than touch events, so every gesture works with a mouse during
 * development and with a finger in production, from one code path.
 *
 * The hand's grammar, in order of primacy:
 *
 *   drag a card out of the fan     play it, dropping it where it goes — onto your
 *                                  board, onto the creature it targets, onto a face
 *   tap a card                     play it the one legal way, or start aiming it
 *   hold a card                    read it, full size, committing to nothing
 *
 * Drag is the primary verb because it carries the answer to "where?" in the same
 * motion as "play this" — a targeted spell lands on its target instead of entering a
 * mode. Tap remains for speed and for anyone who never discovers the drag; hold is
 * how you read. Nothing is reachable only by gesture.
 *
 * Elsewhere: swipe up on your creature attacks with it; long-press the mana row opens
 * the real lands.
 */

/** Where a dragged card was let go. */
export type DropTarget =
  | { kind: 'card'; id: string }
  | { kind: 'player'; id: 0 | 1 }
  | { kind: 'board' }
  | { kind: 'nowhere' };

export interface GestureCallbacks {
  onSwipeUp(card: string): void;
  onLongPress(target: HTMLElement): void;
  /** A hand card held still: open the reader. */
  onHandPeek(card: string): void;
  /** A drag has left the fan — light the places this card may go. */
  onDragStart(card: string): void;
  /** The drop target under the finger changed mid-drag. Fires only on change. */
  onDragOver(card: string, target: DropTarget): void;
  /** The card was released. Always paired with onDragStart, even for 'nowhere'. */
  onDrop(card: string, target: DropTarget): void;
}

/** A swipe is deliberately strict: a sloppy scroll must not launch an attack. */
const SWIPE_MIN_DISTANCE = 40;
const SWIPE_MAX_DRIFT = 30;
const SWIPE_MAX_DURATION = 300;
const LONG_PRESS_MS = 420;
/** Past this, a touch on a hand card stops being a tap and becomes a drag. */
const DRAG_THRESHOLD = 14;
/**
 * Deliberately the same number as the drag threshold, not a smaller one.
 *
 * At 10 against a threshold of 14 there was a 4px band where a hold had its read
 * cancelled but no drag ever started — so a shaky finger resting on a card for half a
 * second got neither the reader nor a drag, and the click that followed CAST the card
 * the player was only trying to look at. Matching the two numbers leaves exactly one
 * boundary: under it you are reading, over it you are dragging.
 */
const LONG_PRESS_TOLERANCE = DRAG_THRESHOLD;

interface Tracking {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  card: string | null;
  handCard: string | null;
  handNode: HTMLElement | null;
  dragging: boolean;
  longPressTimer: number | null;
  fired: boolean;
  /** Last target reported to the session, so the hover only repaints on change. */
  over: string;
}

/** What the drop landed on, walking up from whatever elementFromPoint returned. */
function resolveDrop(x: number, y: number): DropTarget {
  const under = document.elementFromPoint(x, y);
  if (!under) return { kind: 'nowhere' };

  const tile = under.closest<HTMLElement>('.tile');
  if (tile?.dataset.card) return { kind: 'card', id: tile.dataset.card };

  const rail = under.closest<HTMLElement>('.rail');
  if (rail) return { kind: 'player', id: rail.classList.contains('rail--you') ? 0 : 1 };

  // Releasing back over the fan is the cancel gesture — the card goes home.
  if (under.closest('.hand')) return { kind: 'nowhere' };

  // EVERYTHING else on the table means "just play it". This started as an allowlist
  // of board-ish zones, and a real thumb immediately found the gaps: the action
  // button sits in the rail band, the stack panel floats over the boards, and a
  // release on any of them read as a cancel that the glowing drop zone had just
  // promised would work. Precision is for targets; the table itself is one zone.
  if (under.closest('.table')) return { kind: 'board' };

  return { kind: 'nowhere' };
}

export function attachGestures(root: HTMLElement, callbacks: GestureCallbacks): () => void {
  let tracking: Tracking | null = null;
  /** Set for one tick after a drag or long-press, so the click that the browser
   *  synthesises from the same pointer sequence cannot also fire the tap action. */
  let swallowClick = false;

  const cancelLongPress = (): void => {
    if (tracking?.longPressTimer !== null && tracking?.longPressTimer !== undefined) {
      clearTimeout(tracking.longPressTimer);
      tracking.longPressTimer = null;
    }
  };

  const endDrag = (node: HTMLElement): void => {
    node.classList.remove('hand__card--dragging');
    node.style.removeProperty('--dx');
    node.style.removeProperty('--dy');
    node.style.removeProperty('--grab');
    // --rot is deliberately NOT cleared here: the next render rewrites it with the
    // card's fan angle, and the base transform transition carries the card home
    // turning as it goes. Clearing it would snap the card upright for one frame first.
  };

  const onDown = (ev: PointerEvent): void => {
    // A new gesture means the previous sequence's click either already fired or never
    // will — browsers are inconsistent about synthesizing one after a long press. A
    // swallow left armed here would eat this NEW gesture's tap instead, which reads as
    // "the game ignored me".
    swallowClick = false;

    const target = ev.target as HTMLElement;
    const tile = target.closest<HTMLElement>('.tile');
    const mana = target.closest<HTMLElement>('.mana--you');
    const hand = target.closest<HTMLElement>('.hand__card');

    tracking = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      startedAt: performance.now(),
      card: tile?.dataset.card ?? null,
      handCard: hand?.dataset.card ?? null,
      handNode: hand,
      dragging: false,
      longPressTimer: null,
      fired: false,
      over: '',
    };

    // Capture, so the rest of this gesture is delivered here no matter what it passes
    // over or what re-renders underneath it. Without it a release outside the root —
    // off the top of the screen, past the bottom edge the fan hangs over — never
    // arrives, and the card stays frozen in mid-air with pointer-events off, which
    // ends the game as surely as a crash.
    try { root.setPointerCapture(ev.pointerId); } catch { /* not capturable; the plain path still works */ }

    const held = mana
      ? () => callbacks.onLongPress(mana)
      : hand?.dataset.card
        ? () => callbacks.onHandPeek(hand.dataset.card!)
        : null;

    if (held) {
      tracking.longPressTimer = window.setTimeout(() => {
        if (!tracking || tracking.dragging) return;
        tracking.fired = true;
        swallowClick = true;
        // Confirms the gesture landed, which matters when the result is a panel the
        // player has not seen before.
        if ('vibrate' in navigator) navigator.vibrate?.(12);
        held();
      }, LONG_PRESS_MS);
    }
  };

  const onMove = (ev: PointerEvent): void => {
    if (!tracking || ev.pointerId !== tracking.pointerId) return;
    const dx = ev.clientX - tracking.startX;
    const dy = ev.clientY - tracking.startY;
    const drift = Math.hypot(dx, dy);

    if (drift > LONG_PRESS_TOLERANCE) cancelLongPress();

    if (tracking.handCard && tracking.handNode && !tracking.fired) {
      if (!tracking.dragging && drift > DRAG_THRESHOLD) {
        tracking.dragging = true;
        tracking.handNode.classList.add('hand__card--dragging');
        // Inline, because the fan's own angle is written inline by the renderer on
        // every repaint and a stylesheet rule cannot outrank it. The lift belongs to
        // whoever owns the drag, which is this file — the same place --dx/--dy live.
        tracking.handNode.style.setProperty('--rot', '0deg');
        tracking.handNode.style.setProperty('--grab', '1.12');
        callbacks.onDragStart(tracking.handCard);
      }
      if (tracking.dragging) {
        tracking.handNode.style.setProperty('--dx', `${dx}px`);
        tracking.handNode.style.setProperty('--dy', `${dy}px`);
        ev.preventDefault();

        // Which of the lit targets is actually under the finger. Every legal target
        // glowing tells the player where a card MAY go; it does not tell them where
        // THIS release will send it, which is the only question at the moment of
        // letting go. Keyed so a repaint costs nothing while the finger sits still.
        const target = resolveDrop(ev.clientX, ev.clientY);
        const key = target.kind === 'card' ? `card:${target.id}`
          : target.kind === 'player' ? `player:${target.id}`
          : target.kind;
        if (key !== tracking.over) {
          tracking.over = key;
          callbacks.onDragOver(tracking.handCard, target);
        }
      }
    }
  };

  const onUp = (ev: PointerEvent): void => {
    if (!tracking || ev.pointerId !== tracking.pointerId) return;
    cancelLongPress();
    try { root.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }

    if (tracking.dragging && tracking.handCard && tracking.handNode) {
      // Ask what is under the finger BEFORE sending the card home. `endDrag` restores
      // pointer-events on the dragged node, and for the first frame of its journey back
      // it is still sitting exactly where it was released — so the hit test finds the
      // card itself, `.closest('.hand')` matches, and every drop reads as a cancel.
      //
      // This is why dropping on the action button worked while dropping on the felt did
      // not: the button's z-index beat the returning card and won the hit test, so the
      // one place the bug was invisible was the one place it got tested.
      const landed = resolveDrop(ev.clientX, ev.clientY);
      endDrag(tracking.handNode);
      swallowClick = true;
      callbacks.onDrop(tracking.handCard, landed);
      tracking = null;
      return;
    }

    // A long press already did something; the click that follows must not also play
    // the card the player was only trying to read.
    if (tracking.fired) {
      tracking = null;
      return;
    }

    const dx = ev.clientX - tracking.startX;
    const dy = ev.clientY - tracking.startY;
    const elapsed = performance.now() - tracking.startedAt;

    const isSwipeUp =
      tracking.card !== null &&
      dy < -SWIPE_MIN_DISTANCE &&
      Math.abs(dx) < SWIPE_MAX_DRIFT &&
      elapsed < SWIPE_MAX_DURATION;

    if (isSwipeUp) {
      ev.preventDefault();
      swallowClick = true;
      const card = tracking.card!;
      tracking = null;
      callbacks.onSwipeUp(card);
      return;
    }

    tracking = null;
  };

  const onCancel = (ev: PointerEvent): void => {
    cancelLongPress();
    try { root.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
    if (tracking?.dragging && tracking.handNode && tracking.handCard) {
      endDrag(tracking.handNode);
      callbacks.onDrop(tracking.handCard, { kind: 'nowhere' });
    }
    tracking = null;
  };

  const onClick = (ev: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    ev.stopPropagation();
    ev.preventDefault();
  };

  /*
   * A gesture BEGINS on the table and may end anywhere.
   *
   * Binding the end of it to the table was a trap: release past the bottom edge the fan
   * hangs over, or off the top of the screen, and the pointerup never arrived — leaving
   * the card frozen in mid-air with pointer-events off, which ends the game as surely
   * as a crash. Pointer capture above handles this for a real finger; the window
   * listeners are what make it true unconditionally, including where capture is
   * refused. Both can fire for one release, and the second is a no-op because the first
   * clears `tracking`.
   */
  root.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  // Capture phase, so the swallow beats every per-card click handler.
  root.addEventListener('click', onClick, true);

  return () => {
    root.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    root.removeEventListener('click', onClick, true);
  };
}
