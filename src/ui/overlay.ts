/**
 * Card zoom and zone browsing.
 *
 * The battlefield deliberately strips the card frame away so the art can be large. The
 * cost of that is you can no longer read the card, so tapping anything shows the real
 * printed card, at a size worth looking at, with its illustrator credited.
 */

import type { CardId, GameState, PlayerId } from '../engine/types';
import { def, inst } from '../engine/state';
import { el, clear } from './dom';
import { sound } from '../audio/kit';

let current: HTMLElement | null = null;

function close(): void {
  if (!current) return;
  sound.play('zoom-close', { gain: 0.5 });
  current.remove();
  current = null;
}

function open(host: HTMLElement, content: HTMLElement, label: string): void {
  close();
  sound.play('zoom-open', { gain: 0.6 });

  const overlay = el('div.overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  overlay.append(content);
  overlay.addEventListener('click', close);

  // Escape is not reachable on a phone, but this is also a desktop-playable page.
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }
  };
  window.addEventListener('keydown', onKey);

  host.append(overlay);
  current = overlay;
}

/** The full printed card, plus who painted it. */
export function showCard(host: HTMLElement, state: GameState, card: CardId): void {
  const card_ = inst(state, card);
  const d = def(state, card);

  if (card_.isToken) {
    const spec = card_.tokenSpec;
    const body = el('div', { style: 'text-align:center' },
      el<HTMLImageElement>('img.overlay__card', { src: spec?.art ?? '', alt: spec?.name ?? 'Token' }),
      el('div.overlay__artist', { text: `${spec?.name ?? 'Token'} · ${spec?.power ?? 0}/${spec?.toughness ?? 0} token` }),
    );
    open(host, body, spec?.name ?? 'Token');
    return;
  }

  const image = el<HTMLImageElement>('img.overlay__card', { src: d.image, alt: d.name });
  image.onerror = () => { image.replaceWith(fallbackCard(state, card)); };

  const body = el('div', { style: 'text-align:center;position:relative' },
    image,
    el('div.overlay__artist', { text: d.artist ? `Illustrated by ${d.artist}` : '' }),
  );
  open(host, body, d.name);
}

/**
 * If an image is missing, show the card as text rather than a hole. A player can still
 * make the decision in front of them from name, cost and rules text.
 */
function fallbackCard(state: GameState, card: CardId): HTMLElement {
  const d = def(state, card);
  return el('div', {
    style: 'max-width:260px;padding:18px;border-radius:11px;background:var(--zone);'
      + 'border:1px solid var(--edge-hi);color:var(--ink);text-align:left',
  },
    el('div', { style: 'font-family:var(--font-serif);font-size:19px;margin-bottom:4px', text: d.name }),
    el('div', { style: 'font-size:12px;color:var(--ink-3);margin-bottom:10px', text: d.cardTypes.join(' ') }),
    el('div', { style: 'font-size:13px;line-height:1.5;color:var(--ink-2)', text: d.oracleText || '—' }),
    d.power !== undefined
      ? el('div', { style: 'margin-top:10px;font-family:var(--font-mono);font-size:15px', text: `${d.power}/${d.toughness}` })
      : null,
  );
}

/** Graveyard and exile, as a scrollable grid of real cards. */
export function showZone(
  host: HTMLElement, state: GameState, zone: 'graveyard' | 'exile', player: PlayerId,
): void {
  const ids = state.players[player][zone];

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:340px;'
      + 'max-height:70vh;overflow-y:auto;padding:4px',
  });

  if (!ids.length) {
    grid.append(el('div', {
      style: 'grid-column:1/-1;text-align:center;color:var(--ink-3);font-size:13px;padding:28px 0',
      text: zone === 'graveyard' ? 'Nothing has died yet.' : 'Nothing exiled.',
    }));
  }

  for (const id of ids) {
    const d = def(state, id);
    const thumb = el<HTMLImageElement>('img', {
      src: d.image, alt: d.name,
      style: 'width:100%;border-radius:5px;display:block;border:1px solid rgb(0 0 0 / .5)',
    });
    grid.append(thumb);
  }

  const body = el('div', { style: 'width:100%;display:flex;flex-direction:column;align-items:center;gap:10px' },
    el('div', {
      style: 'font-family:var(--font-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)',
      text: `${zone} · ${ids.length}`,
    }),
    grid,
  );

  open(host, body, `${zone}, ${ids.length} cards`);
}

/**
 * The real lands behind the mana row.
 *
 * The gems are a summary; this is where the abstraction gives way and shows the cards
 * they stand for, tapped ones rotated exactly as they would be on a table.
 */
export function showLands(host: HTMLElement, state: GameState, player: PlayerId): void {
  const lands = state.players[player].battlefield.filter(id =>
    def(state, id).cardTypes.includes('land'));

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:340px;'
      + 'max-height:66vh;overflow-y:auto;padding:4px',
  });

  if (!lands.length) {
    grid.append(el('div', {
      style: 'grid-column:1/-1;text-align:center;color:var(--ink-3);font-size:13px;padding:28px 0',
      text: 'No lands yet. Playing one is the most important thing you do each turn.',
    }));
  }

  for (const id of lands) {
    const tapped = inst(state, id).tapped;
    grid.append(el<HTMLImageElement>('img', {
      src: def(state, id).image,
      alt: `${def(state, id).name}${tapped ? ', tapped' : ''}`,
      style: 'width:100%;border-radius:5px;display:block;border:1px solid rgb(0 0 0 / .5);'
        + (tapped ? 'filter:brightness(.55) saturate(.6);transform:rotate(6deg)' : ''),
    }));
  }

  const untapped = lands.filter(id => !inst(state, id).tapped).length;
  const body = el('div', { style: 'width:100%;display:flex;flex-direction:column;align-items:center;gap:10px' },
    el('div', {
      style: 'font-family:var(--font-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)',
      text: `lands · ${untapped} of ${lands.length} untapped`,
    }),
    grid,
    el('div', {
      style: 'font-size:12px;color:var(--ink-3);max-width:300px;text-align:center;line-height:1.5',
      text: 'Mana is spent for you when you cast. These are the lands it comes from.',
    }),
  );

  open(host, body, `Lands, ${untapped} of ${lands.length} untapped`);
}

/** Mulligan decision, shown before the first turn. */
export function showMulligan(
  host: HTMLElement, state: GameState, player: PlayerId,
  onKeep: () => void, onMulligan: () => void,
): void {
  const hand = state.players[player].hand;
  const taken = state.players[player].mulligansTaken;

  const row = el('div', { style: 'display:flex;justify-content:center;flex-wrap:wrap;gap:4px;max-width:340px' });
  for (const id of hand) {
    row.append(el<HTMLImageElement>('img', {
      src: def(state, id).image, alt: def(state, id).name,
      style: 'width:64px;border-radius:4px;border:1px solid rgb(0 0 0 / .5)',
    }));
  }

  const keep = el<HTMLButtonElement>('button.act', {
    type: 'button', style: 'position:static;box-shadow:none', text: taken ? `Keep ${7 - taken}` : 'Keep',
  });
  const mull = el<HTMLButtonElement>('button.act', {
    type: 'button',
    style: 'position:static;background:transparent;color:var(--ink-2);border-color:var(--edge-hi);box-shadow:none',
    text: 'Mulligan',
  });
  mull.disabled = taken >= 3;

  keep.addEventListener('click', () => { close(); onKeep(); });
  mull.addEventListener('click', () => { close(); onMulligan(); });

  const body = el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:14px' },
    el('div', {
      style: 'font-family:var(--font-serif);font-size:19px;color:var(--ink)',
      text: 'Your opening hand',
    }),
    row,
    el('div', {
      style: 'font-size:12.5px;color:var(--ink-3);max-width:300px;text-align:center;line-height:1.5',
      text: taken >= 3
        ? 'That is the last mulligan. This is your hand.'
        : 'Two to four lands is a good keep. A hand with none is not.',
    }),
    el('div', { style: 'display:flex;gap:10px' }, keep, mull),
  );

  // A mulligan decision must be made, so this overlay does not close on background tap.
  close();
  const overlay = el('div.overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Opening hand' });
  overlay.append(body);
  host.append(overlay);
  current = overlay;
}

export function closeOverlay(): void {
  close();
}

/** Wired once at startup; the session raises this rather than importing the overlay. */
export function listenForZoom(host: HTMLElement): void {
  window.addEventListener('emteegee:zoom', ev => {
    const detail = (ev as CustomEvent<{ card: CardId; state: GameState }>).detail;
    showCard(host, detail.state, detail.card);
  });
}

export { clear };
