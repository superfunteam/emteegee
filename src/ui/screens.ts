/**
 * Title, deck select, result, settings.
 *
 * Four screens is the whole shell. Everything else is the match, which is the point —
 * the product is the game, not the menus around it.
 */

import type { PlayerId } from '../engine/types';
import type { Deck } from '../decks/types';
import type { Tier } from '../bot/magician';
import { el, clear } from './dom';
import { sound } from '../audio/kit';
import { resetHints, hintsRemaining } from './hints';

export type Skin = 'felt' | 'parchment' | 'slate';

const SKIN_KEY = 'emteegee.skin';

const MANA_CLASS: Record<string, string> = {
  W: 'gem--w', U: 'gem--u', B: 'gem--b', R: 'gem--r', G: 'gem--g',
};

const TIERS: Array<{ id: Tier; name: string; note: string }> = [
  { id: 'apprentice', name: 'Apprentice', note: 'Learning the trade. Misses things.' },
  { id: 'magician', name: 'Magician', note: 'Knows the tricks. Plays them well.' },
  { id: 'archmage', name: 'Archmage', note: 'Sees your hand before you do.' },
];

export function loadSkin(): Skin {
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    if (saved === 'felt' || saved === 'parchment' || saved === 'slate') return saved;
  } catch {
    // Fall through to the default.
  }
  return 'felt';
}

export function applySkin(skin: Skin, _host: HTMLElement): void {
  // The tokens live on :root, so one attribute repaints the table and every screen at
  // once — and the body background matches even where nothing is rendered yet.
  document.documentElement.dataset.skin = skin;
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    // Private browsing: the skin resets next session.
  }
}

/* ------------------------------------------------------------------ title */

export function titleScreen(onPlay: () => void, onSettings: () => void): HTMLElement {
  const play = el<HTMLButtonElement>('button.title__play', { type: 'button', text: 'Play' });
  play.addEventListener('click', () => { sound.unlock(); sound.play('button'); onPlay(); });

  const settings = el<HTMLButtonElement>('button.title__link', { type: 'button', text: 'Settings' });
  settings.addEventListener('click', () => { sound.unlock(); sound.play('blip'); onSettings(); });

  return el('div.screen.title', {},
    el('h1.title__mark', { html: 'emtee<em>gee</em>' }),
    el('p.title__tag', { text: 'The easiest way to play the best card game.' }),
    play,
    el('div.title__row', {}, settings),
    el('p.title__foot', {
      html: 'Card images and data from <b>Scryfall</b>. Sounds by <b>Kenney</b> (CC0). '
        + 'An open-source demo for learning Magic — not affiliated with Wizards of the Coast.',
    }),
  );
}

/* ------------------------------------------------------------ deck select */

export function deckScreen(
  decks: Deck[],
  onStart: (deck: Deck, tier: Tier) => void,
  onBack: () => void,
): HTMLElement {
  let chosenDeck: Deck | null = null;
  let chosenTier: Tier = 'apprentice';

  const start = el<HTMLButtonElement>('button.start', { type: 'button', text: 'Choose a deck' });
  start.disabled = true;

  const grid = el('div.decks', { role: 'group', 'aria-label': 'Decks' });
  const deckButtons = new Map<string, HTMLElement>();

  for (const deck of decks) {
    const button = el<HTMLButtonElement>('button.deck', {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': `${deck.name}, ${deck.theme}. Teaches ${deck.teaches}.`,
    },
      el<HTMLImageElement>('img.deck__art', { src: `art/${deck.signature}-art.jpg`, alt: '' }),
      el('div.deck__body', {},
        el('div.deck__name', { text: deck.name }),
        el('div.deck__theme', { text: deck.theme }),
        el('div.deck__pips', {},
          ...deck.colors.map(c => el('span.deck__pip', { class: `deck__pip ${MANA_CLASS[c] ?? ''}` })),
          el('span.deck__teaches', { text: deck.teaches }),
        ),
      ),
    );

    button.addEventListener('click', () => {
      chosenDeck = deck;
      sound.play('select');
      for (const [id, node] of deckButtons) node.setAttribute('aria-pressed', String(id === deck.id));
      start.disabled = false;
      start.textContent = `Play ${deck.name}`;
    });

    deckButtons.set(deck.id, button);
    grid.append(button);
  }

  const tierRow = el('div.tiers', { role: 'group', 'aria-label': 'Difficulty' });
  const tierButtons = new Map<Tier, HTMLElement>();
  for (const tier of TIERS) {
    const button = el<HTMLButtonElement>('button.tier', {
      type: 'button',
      'aria-pressed': String(tier.id === chosenTier),
      'aria-label': `${tier.name}. ${tier.note}`,
    },
      el('div.tier__name', { text: tier.name }),
      el('div.tier__note', { text: tier.note }),
    );
    button.addEventListener('click', () => {
      chosenTier = tier.id;
      sound.play('blip');
      for (const [id, node] of tierButtons) node.setAttribute('aria-pressed', String(id === tier.id));
    });
    tierButtons.set(tier.id, button);
    tierRow.append(button);
  }

  start.addEventListener('click', () => {
    if (!chosenDeck) return;
    sound.play('shuffle');
    onStart(chosenDeck, chosenTier);
  });

  const back = el<HTMLButtonElement>('button.screen__back', { type: 'button', text: '← back' });
  back.addEventListener('click', onBack);

  return el('div.screen', {},
    el('div.screen__head', {},
      el('h2.screen__title', { text: 'Pick a deck' }),
      back,
    ),
    el('p.screen__sub', { text: 'Each one teaches a different way to win.' }),
    grid,
    el('h2.screen__title', { style: 'font-size:19px;margin-top:24px', text: 'The Magician' }),
    tierRow,
    start,
  );
}

/* ----------------------------------------------------------------- result */

export interface ResultInfo {
  winner: PlayerId;
  you: PlayerId;
  deck: Deck;
  tier: Tier;
  turns: number;
  yourLife: number;
  theirLife: number;
  /** One line explaining how it ended, written from the board rather than generically. */
  how: string;
}

export function resultScreen(
  info: ResultInfo,
  onAgain: () => void,
  onSwitch: () => void,
): HTMLElement {
  const won = info.winner === info.you;

  const again = el<HTMLButtonElement>('button.result__again', { type: 'button', text: 'Play again' });
  again.addEventListener('click', () => { sound.play('button'); onAgain(); });

  const swap = el<HTMLButtonElement>('button.result__switch', { type: 'button', text: 'Change deck' });
  swap.addEventListener('click', () => { sound.play('blip'); onSwitch(); });

  const verdict = el('h2.result__verdict', { text: won ? 'You win' : 'The Magician wins' });
  verdict.classList.add(won ? 'result__verdict--win' : 'result__verdict--loss');

  return el('div.screen.result', {},
    verdict,
    el('p.result__how', { text: info.how }),
    el('div.result__stats', {},
      stat(String(info.turns), 'turns'),
      stat(String(Math.max(0, info.yourLife)), 'your life'),
      stat(String(Math.max(0, info.theirLife)), 'their life'),
    ),
    el('div.result__row', {}, again, swap),
  );
}

function stat(value: string, label: string): HTMLElement {
  return el('div.result__stat', {},
    el('div.result__value', { text: value }),
    el('div.result__label', { text: label }),
  );
}

/* --------------------------------------------------------------- settings */

export function settingsScreen(
  current: Skin,
  onSkin: (skin: Skin) => void,
  onBack: () => void,
): HTMLElement {
  const back = el<HTMLButtonElement>('button.screen__back', { type: 'button', text: '← back' });
  back.addEventListener('click', onBack);

  const swatches = el('div.swatches', { role: 'group', 'aria-label': 'Table skin' });
  const skinButtons = new Map<Skin, HTMLElement>();
  for (const skin of ['felt', 'parchment', 'slate'] as const) {
    const button = el<HTMLButtonElement>('button.swatch', {
      type: 'button',
      class: `swatch swatch--${skin}`,
      'aria-pressed': String(skin === current),
      'aria-label': skin,
    });
    button.addEventListener('click', () => {
      sound.play('blip');
      for (const [id, node] of skinButtons) node.setAttribute('aria-pressed', String(id === skin));
      onSkin(skin);
    });
    skinButtons.set(skin, button);
    swatches.append(button);
  }

  const muteButton = el<HTMLButtonElement>('button.title__link', {
    type: 'button', text: sound.muted ? 'Sound off' : 'Sound on',
  });
  muteButton.addEventListener('click', () => {
    sound.setMuted(!sound.muted);
    muteButton.textContent = sound.muted ? 'Sound off' : 'Sound on';
    if (!sound.muted) sound.play('blip');
  });

  const hintsButton = el<HTMLButtonElement>('button.title__link', {
    type: 'button', text: 'Show hints again',
  });
  const hintsNote = el('div.setting__hint', {
    text: `${hintsRemaining()} hints still to appear`,
  });
  hintsButton.addEventListener('click', () => {
    resetHints();
    sound.play('blip');
    hintsNote.textContent = `${hintsRemaining()} hints still to appear`;
  });

  return el('div.screen', {},
    el('div.screen__head', {},
      el('h2.screen__title', { text: 'Settings' }),
      back,
    ),
    el('div.settings', {},
      el('div', {},
        el('div.setting__label', { text: 'Table' }),
        el('div.setting__hint', { text: 'The felt your cards sit on.' }),
        el('div', { style: 'margin-top:10px' }, swatches),
      ),
      el('div.setting', {},
        el('div', {}, el('div.setting__label', { text: 'Sound' })),
        muteButton,
      ),
      el('div.setting', {},
        el('div', {}, el('div.setting__label', { text: 'Hints' }), hintsNote),
        hintsButton,
      ),
    ),
  );
}

export { clear };
