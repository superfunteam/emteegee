/**
 * Entry point.
 *
 * Owns exactly one thing: which screen is on. Everything else is delegated — the
 * session runs the match, the table renders it, the screens handle the shell.
 */

import type { CardDef, GameState, OracleId, PlayerId } from './engine/types';
import { createGame, def } from './engine/state';
import { beginMulligans } from './engine/rules';
import { DECKS } from './decks';
import { deckList, type Deck } from './decks/types';
import type { Tier } from './bot/magician';
import { createTable } from './ui/table';
import { Session, YOU, THEM } from './ui/session';
import { attachGestures } from './ui/gestures';
import { createPrompts, listenForZoom, showCard, showZone, closeOverlay } from './ui/overlay';
import {
  titleScreen, deckScreen, resultScreen, settingsScreen,
  applySkin, loadSkin, type Skin,
} from './ui/screens';
import { sound } from './audio/kit';
import cardsJson from './data/cards.json';

const CARDS = cardsJson as unknown as Record<OracleId, CardDef>;

const app = document.getElementById('app');
if (!app) throw new Error('emteegee: #app is missing from index.html');

let skin: Skin = loadSkin();
let activeSession: Session | null = null;
let detachGestures: (() => void) | null = null;
let detachZoom: (() => void) | null = null;

function show(node: HTMLElement): void {
  closeOverlay();
  detachGestures?.();
  detachGestures = null;
  // The zoom listener captures the table it renders into, so it has to die with it.
  detachZoom?.();
  detachZoom = null;
  activeSession = null;
  app!.replaceChildren(node);
  applySkin(skin, app!);
}

/* ------------------------------------------------------------------ flow */

function goTitle(): void {
  show(titleScreen(goDeckSelect, goSettings));
}

function goSettings(): void {
  show(settingsScreen(skin, next => { skin = next; applySkin(skin, app!); }, goTitle));
}

function goDeckSelect(): void {
  // Sound files land while the player is reading deck names, so the first card they
  // play is never silent.
  void sound.preload();
  show(deckScreen(Object.values(DECKS), startMatch, goTitle));
}

function startMatch(deck: Deck, tier: Tier): void {
  // The Magician picks a deck that is not yours, so a mirror never happens by accident
  // on a first game — the decks are meant to feel distinct.
  const others = Object.values(DECKS).filter(d => d.id !== deck.id);
  const theirs = others[Math.floor(Math.random() * others.length)] ?? deck;

  const seed = Math.floor(Math.random() * 0x7fffffff);
  // `createGame` deals straight into a playable first main phase. A real match takes one
  // more step first: turn zero, where both players decide their opening hands.
  const initial = beginMulligans(createGame(CARDS, deckList(deck), deckList(theirs), seed)).state;

  const table = createTable({
    onTileTap: card => activeSession?.tileTap(card),
    onRailTap: player => activeSession?.railTap(player),
    onHandTap: card => activeSession?.handTap(card),
    onManaTap: player => activeSession?.manaTap(player),
    onZoneTap: (zone, player) => {
      if (activeSession) showZone(table.root, activeSession.gameState, zone, player);
    },
    onAct: () => activeSession?.act(),
  });

  const session = new Session({
    initial,
    tier,
    table,
    prompts: createPrompts(table.root),
    onGameOver: winner => showResult(winner, deck, theirs, tier, session),
  });

  show(table.root);
  activeSession = session;
  detachZoom = listenForZoom(table.root);

  detachGestures = attachGestures(table.root, {
    // Long-pressing the mana row opens the real lands, which is where the abstraction
    // gives way: the gems are a summary, these are the cards you tap.
    onSwipeUp: card => session.swipeUp(card),
    onLongPress: () => session.manaTap(YOU),
    // Holding a card in hand reads it. Tapping casts, so without this the only way to
    // find out what a card does is to play it — which is exactly backwards for the
    // audience this game is for. Reading is not a move, so it goes straight to the
    // overlay: it works on the opponent's turn and mid-animation too.
    onHandPeek: card => showCard(table.root, session.gameState, card),
  });

  session.start();
}

function showResult(
  winner: PlayerId, yourDeck: Deck, theirDeck: Deck, tier: Tier, session: Session,
): void {
  const state = session.gameState;
  show(resultScreen(
    {
      winner,
      you: YOU,
      deck: yourDeck,
      tier,
      turns: state.turn,
      yourLife: state.players[YOU].life,
      theirLife: state.players[THEM].life,
      how: describeEnding(state, winner, theirDeck),
    },
    () => startMatch(yourDeck, tier),
    goDeckSelect,
  ));
}

/**
 * Says what actually happened rather than "you won". A player who lost at 1 life to a
 * flier learned something different than one who was decked.
 */
function describeEnding(state: GameState, winner: PlayerId, theirDeck: Deck): string {
  const won = winner === YOU;
  const loserLife = state.players[won ? THEM : YOU].life;
  const winnerLife = state.players[won ? YOU : THEM].life;

  if (loserLife > 0) {
    return won
      ? 'The Magician ran out of cards. A win is a win.'
      : 'You ran out of cards to draw.';
  }
  if (winnerLife <= 3) {
    return won
      ? `That was close. You beat ${theirDeck.name} with ${winnerLife} life to spare.`
      : `So close — ${theirDeck.name} got there with ${winnerLife} life left.`;
  }
  if (won) {
    return `${theirDeck.name} never got going. You finished with ${winnerLife} life.`;
  }
  return `${theirDeck.name} was too fast this time. Try a different deck, or a gentler Magician.`;
}

/* ---------------------------------------------------------------- startup */

applySkin(skin, app);
goTitle();

// A game rendered mid-animation on a resized viewport should settle, not stay wrong.
window.addEventListener('orientationchange', () => {
  setTimeout(() => activeSession?.skipAnimation(), 120);
});

export { showCard, def };
