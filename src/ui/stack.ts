/**
 * The stack.
 *
 * Everything else in this game is visible on the table — creatures, lands, life, the
 * cards in your hand. The stack was the exception: you could respond to a spell, but
 * you could not see it. The only trace of it in the interface was the word "Pass"
 * appearing on the action button, which tells a beginner nothing about *why*.
 *
 * That matters more here than it would in a game with a smaller rules footprint. The
 * whole reason this game keeps a real stack, capped at three, is to preserve the
 * combat-trick moment: you cast something, they answer, and the answer resolves first.
 * None of that reads unless the objects are on screen, in order, with the one that
 * resolves next unmistakably marked.
 *
 * Reads the same `GameState` as everything else and changes nothing.
 */

import type { CardId, GameState, PlayerId, StackObject } from '../engine/types';
import { def, inst } from '../engine/state';
import { el, clear } from './dom';

/** What a stack object is, in a handful of words a beginner can act on. */
function describe(state: GameState, object: StackObject): string {
  const card = state.cards[object.source];
  if (!card) return object.isTriggered ? 'A triggered ability' : 'A spell';

  const name = card.isToken ? (card.tokenSpec?.name ?? 'Token') : def(state, object.source).name;
  return object.isTriggered ? `${name}'s ability` : name;
}

/** Who or what it points at, if anything. */
function describeTarget(state: GameState, object: StackObject, you: PlayerId): string | null {
  const targets = object.targets;
  if (targets === null) return null;

  if (targets === 'player0') return you === 0 ? 'you' : 'The Magician';
  if (targets === 'player1') return you === 1 ? 'you' : 'The Magician';

  const names = targets
    .map(id => {
      const card = state.cards[id];
      if (!card) return null;
      return card.isToken ? (card.tokenSpec?.name ?? 'a token') : def(state, id).name;
    })
    .filter((n): n is string => n !== null);

  return names.length ? names.join(', ') : null;
}

function artFor(state: GameState, source: CardId): string {
  const card = state.cards[source];
  if (!card) return '';
  return card.isToken ? (card.tokenSpec?.art ?? '') : def(state, source).art;
}

/**
 * Paint the stack, or clear it away when nothing is waiting.
 *
 * Rendered topmost-first: the object that resolves next is at the top, because that is
 * the one the player's decision is actually about. Magic resolves the stack backwards
 * from how it was built, and showing it in build order would teach the wrong thing at
 * exactly the moment the player is trying to learn it.
 */
export function patchStack(
  node: HTMLElement,
  state: GameState,
  you: PlayerId,
  onRead?: (card: CardId) => void,
): void {
  const objects = state.stack;

  if (objects.length === 0) {
    if (node.childElementCount) clear(node);
    node.hidden = true;
    return;
  }

  node.hidden = false;

  // Cheap identity check: the stack is at most three objects, and rebuilding it on
  // every animation beat would restart the entry animation of things already there.
  const signature = objects.map(o => `${o.id}:${String(o.targets)}`).join('|');
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;

  clear(node);
  node.append(el('div.stack__title', {
    'aria-hidden': 'true',
    text: objects.length === 1 ? 'Waiting to happen' : `${objects.length} waiting`,
  }));

  // Top of the stack first — the next thing to resolve is the top row.
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i]!;
    const next = i === objects.length - 1;
    const mine = object.controller === you;
    const target = describeTarget(state, object, you);

    const row = el<HTMLButtonElement>('button.stack__item', {
      type: 'button',
      dataOwner: mine ? 'you' : 'them',
      // The travel ghosts need to find "where this spell sits on the stack" — both as
      // a destination when it is cast and as a remembered origin when it resolves.
      dataCard: object.source,
      'aria-label': `Read ${describe(state, object)}`,
    },
      el<HTMLImageElement>('img.stack__art', { src: artFor(state, object.source), alt: '' }),
      el('div.stack__body', {},
        el('div.stack__name', { text: describe(state, object) }),
        el('div.stack__meta', {
          text: [mine ? 'yours' : 'The Magician', target ? `→ ${target}` : null]
            .filter(Boolean)
            .join(' '),
        }),
      ),
      next ? el('div.stack__next', { text: 'next' }) : null,
    );

    if (next) row.classList.add('stack__item--next');
    // The thing about to happen to you is the thing you most need to read.
    if (onRead) row.addEventListener('click', () => onRead(object.source));
    else row.disabled = true;
    node.append(row);
  }

  node.setAttribute('aria-label', summarize(state, you));
}

/**
 * The whole stack as one sentence, for a screen reader.
 *
 * Read as a list of rows this would be a pile of card names with no ordering, and the
 * ordering is the entire point.
 */
function summarize(state: GameState, you: PlayerId): string {
  const parts: string[] = [];
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const object = state.stack[i]!;
    const target = describeTarget(state, object, you);
    const owner = object.controller === you ? 'yours' : "The Magician's";
    const position = i === state.stack.length - 1 ? 'resolving next' : `then`;
    parts.push(`${position}: ${describe(state, object)}, ${owner}${target ? `, targeting ${target}` : ''}`);
  }
  return `Waiting to happen. ${parts.join('. ')}`;
}

export { inst };
