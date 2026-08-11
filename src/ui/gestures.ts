/**
 * Touch gestures.
 *
 * Pointer Events rather than touch events, so every gesture works with a mouse during
 * development and with a finger in production, from one code path.
 *
 * Two gestures beyond the tap:
 *   swipe up on a creature   attack with just that creature
 *   long press on the mana row   open the real lands for manual tapping
 *
 * Both are shortcuts. Everything they do is also reachable by tapping, because a
 * gesture nobody discovers must never be the only way to do something.
 */

export interface GestureCallbacks {
  onSwipeUp(card: string): void;
  onLongPress(target: HTMLElement): void;
  /**
   * A hand card held down rather than tapped.
   *
   * Tapping a hand card casts it, so without this there is no way to read a card
   * before committing to it — a beginner would have to play a card to find out what
   * it does, which is exactly backwards.
   */
  onHandPeek(card: string): void;
}

/** A swipe is deliberately strict: a sloppy scroll must not launch an attack. */
const SWIPE_MIN_DISTANCE = 40;
const SWIPE_MAX_DRIFT = 30;
const SWIPE_MAX_DURATION = 300;
const LONG_PRESS_MS = 420;
const LONG_PRESS_TOLERANCE = 10;

interface Tracking {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  card: string | null;
  handCard: string | null;
  longPressTimer: number | null;
  longPressTarget: HTMLElement | null;
  fired: boolean;
}

export function attachGestures(root: HTMLElement, callbacks: GestureCallbacks): () => void {
  let tracking: Tracking | null = null;

  const cancelLongPress = (): void => {
    if (tracking?.longPressTimer !== null && tracking?.longPressTimer !== undefined) {
      clearTimeout(tracking.longPressTimer);
      tracking.longPressTimer = null;
    }
  };

  const onDown = (ev: PointerEvent): void => {
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
      longPressTimer: null,
      longPressTarget: mana,
      fired: false,
    };

    const held = mana
      ? () => callbacks.onLongPress(mana)
      : hand?.dataset.card
        ? () => callbacks.onHandPeek(hand.dataset.card!)
        : null;

    if (held) {
      tracking.longPressTimer = window.setTimeout(() => {
        if (!tracking) return;
        tracking.fired = true;
        // Confirms the gesture landed, which matters when the result is a panel the
        // player has not seen before.
        if ('vibrate' in navigator) navigator.vibrate?.(12);
        held();
      }, LONG_PRESS_MS);
    }
  };

  const onMove = (ev: PointerEvent): void => {
    if (!tracking || ev.pointerId !== tracking.pointerId) return;
    const drift = Math.hypot(ev.clientX - tracking.startX, ev.clientY - tracking.startY);
    if (drift > LONG_PRESS_TOLERANCE) cancelLongPress();
  };

  const onUp = (ev: PointerEvent): void => {
    if (!tracking || ev.pointerId !== tracking.pointerId) return;
    cancelLongPress();

    const dx = ev.clientX - tracking.startX;
    const dy = ev.clientY - tracking.startY;
    const elapsed = performance.now() - tracking.startedAt;

    // A long press already did something; the click that follows must not also cast
    // the card the player was only trying to read.
    if (tracking.fired && tracking.handCard !== null) {
      ev.preventDefault();
      ev.stopPropagation();
      tracking = null;
      return;
    }

    const isSwipeUp =
      tracking.card !== null &&
      !tracking.fired &&
      dy < -SWIPE_MIN_DISTANCE &&
      Math.abs(dx) < SWIPE_MAX_DRIFT &&
      elapsed < SWIPE_MAX_DURATION;

    if (isSwipeUp) {
      // The click that would otherwise follow this pointer sequence would toggle the
      // same creature straight back off.
      ev.preventDefault();
      const card = tracking.card!;
      tracking = null;
      callbacks.onSwipeUp(card);
      return;
    }

    tracking = null;
  };

  const onCancel = (): void => { cancelLongPress(); tracking = null; };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onCancel);

  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onCancel);
  };
}
