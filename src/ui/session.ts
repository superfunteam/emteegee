/**
 * The session: one match, from opening hand to win screen.
 *
 * This is the only place that connects the engine, the bot, the animator and the
 * table. Everything it does follows one loop:
 *
 *     intent -> legality check -> reduce -> animate events -> hand priority back
 *
 * State flows strictly one way. The table renders from GameState and never changes it;
 * the animator consumes events and never produces them. When the bot has priority the
 * same loop runs with the bot supplying the action, which is why there is no separate
 * "bot mode" anywhere in here.
 */

import type { Action, CardId, GameEvent, GameState, PlayerId, TargetSelection } from '../engine/types';
import { def, inst, isCreature, opponentOf } from '../engine/state';
import { inMulligan, legalActions } from '../engine/actions';
import { reduce } from '../engine/rules';
import { chooseAction, type Tier } from '../bot/magician';
import { speechFor } from '../bot/personality';
import { Animator } from './animator';
import { sound } from '../audio/kit';
import type { TableView, UiState } from './table';
import type { PromptView } from './overlay';
import { hintFor } from './hints';

export const YOU: PlayerId = 0;
export const THEM: PlayerId = 1;

/** What the player is in the middle of doing. Purely presentational. */
type Mode =
  | { kind: 'idle' }
  | { kind: 'targeting'; card: CardId; chosen: CardId[] }
  | { kind: 'attacking'; picked: Set<CardId> }
  | { kind: 'blocking'; blocker: CardId | null; pairs: Map<CardId, CardId> };

/**
 * A question the engine is waiting on, currently in front of the player.
 *
 * Distinct from `Mode`, which is something the player started. A prompt is something
 * the *game* started: it appears without being asked for, it is the only thing that can
 * be done while it is up, and until it is answered the big button has nothing to say.
 */
type Prompt = 'mulligan' | 'scry' | 'order';

export interface SessionOptions {
  initial: GameState;
  tier: Tier;
  table: TableView;
  prompts: PromptView;
  onGameOver(winner: PlayerId): void;
}

export class Session {
  private state: GameState;
  private mode: Mode = { kind: 'idle' };
  private prompt: Prompt | null = null;
  private animator: Animator;
  private table: TableView;
  private prompts: PromptView;
  private tier: Tier;
  private onGameOver: (winner: PlayerId) => void;
  private speech: string | null = null;
  private hint: string | null = null;
  private busy = false;

  constructor(opts: SessionOptions) {
    this.state = opts.initial;
    this.table = opts.table;
    this.prompts = opts.prompts;
    this.tier = opts.tier;
    this.onGameOver = opts.onGameOver;
    this.animator = new Animator(event => this.renderEvent(event));
  }

  start(): void {
    this.render();
    this.askIfNeeded();
    void this.runBotIfNeeded();
  }

  /* ------------------------------------------------------------- intents */

  /** A card in hand. Casts it, or enters targeting if it needs a target. */
  handTap(card: CardId): void {
    if (this.blocked()) return;
    sound.unlock();

    // Tapping the card you are already aiming means "never mind". Restarting
    // targeting instead would leave the only exit as a separate Cancel button, and a
    // player who taps the card again expects to put it back down.
    if (this.mode.kind === 'targeting') {
      const sameCard = this.mode.card === card;
      this.mode = { kind: 'idle' };
      this.hint = null;
      sound.play('blip', { gain: 0.5 });
      this.render();
      if (sameCard) return;
    }

    const options = legalActions(this.state).filter(
      a => (a.kind === 'castSpell' || a.kind === 'playLand') && a.card === card,
    );

    if (!options.length) {
      sound.play('illegal', { gain: 0.5 });
      this.flashWhyNot(card);
      return;
    }

    // One legal way to play it means no decision to present.
    if (options.length === 1) {
      void this.dispatch(options[0]!);
      return;
    }

    // Several legal targets: let the player point at one.
    this.mode = { kind: 'targeting', card, chosen: [] };
    this.hint = hintFor('targeting');
    sound.play('select');
    this.render();
  }

  /** A permanent on the battlefield. Meaning depends on what is happening. */
  tileTap(card: CardId): void {
    if (this.blocked()) return;
    sound.unlock();

    switch (this.mode.kind) {
      case 'targeting':
        this.chooseTarget(card);
        return;

      case 'attacking':
        this.toggleAttacker(card);
        return;

      case 'blocking':
        this.assignBlock(card);
        return;

      case 'idle':
        this.zoom(card);
        return;
    }
  }

  /** A player's rail, tapped while a spell is looking for a target. */
  railTap(player: PlayerId): void {
    if (this.blocked()) return;
    if (this.mode.kind !== 'targeting') return;

    const source = this.mode.card;
    const wanted: TargetSelection = player === 0 ? 'player0' : 'player1';
    const match = legalActions(this.state).find(
      a => a.kind === 'castSpell' && a.card === source && a.targets === wanted,
    );
    if (!match) { sound.play('illegal', { gain: 0.5 }); return; }

    this.mode = { kind: 'idle' };
    this.hint = null;
    void this.dispatch(match);
  }

  /** Swipe up on your own creature during declare attackers: attack with just it. */
  swipeUp(card: CardId): void {
    if (this.blocked()) return;
    if (this.state.phase !== 'declareAttackers' || this.state.active !== YOU) return;
    if (inst(this.state, card).controller !== YOU) return;

    const legal = legalActions(this.state).some(
      a => a.kind === 'declareAttackers' && a.attackers.includes(card),
    );
    if (!legal) { sound.play('illegal', { gain: 0.5 }); return; }

    void this.dispatch({ kind: 'declareAttackers', attackers: [card] });
  }

  /**
   * The mana row, tapped or long-pressed: open the real lands.
   *
   * Deliberately not gated on priority. Looking at what you have is not a move, and the
   * lands themselves are only tappable when `legalActions` says so.
   */
  manaTap(player: PlayerId): void {
    // Deliberately not gated on priority — looking at what you have is not a move, and
    // the lands themselves are only tappable when `legalActions` says so.
    //
    // It IS gated on a prompt, though. Prompts share the single overlay slot, so
    // opening this panel while one is up tears the question out of the DOM and leaves
    // a game waiting on an answer nobody can give. The overlay is not inert and the
    // page is keyboard-playable, so this is reachable by tabbing behind the scrim.
    if (this.prompt !== null) return;
    sound.unlock();
    this.prompts.lands(this.state, player, card => this.tapLand(card));
  }

  /** A land tapped inside that panel. Floats its mana; the panel repaints from render. */
  private tapLand(card: CardId): void {
    if (this.blocked()) return;
    const legal = legalActions(this.state).some(a => a.kind === 'tapLand' && a.card === card);
    if (!legal) { sound.play('illegal', { gain: 0.5 }); return; }
    void this.dispatch({ kind: 'tapLand', card });
  }

  /** The one big button. Its label already told the player what this does. */
  act(): void {
    if (this.blocked()) return;
    sound.unlock();
    sound.play('button');

    switch (this.mode.kind) {
      case 'attacking': {
        const attackers = [...this.mode.picked];
        this.mode = { kind: 'idle' };
        void this.dispatch({ kind: 'declareAttackers', attackers });
        return;
      }
      case 'blocking': {
        const blocks = [...this.mode.pairs].map(([blocker, attacker]) => ({ blocker, attacker }));
        this.mode = { kind: 'idle' };
        void this.dispatch({ kind: 'declareBlockers', blocks });
        return;
      }
      case 'targeting':
        // The button reads "Cancel" in this mode.
        this.mode = { kind: 'idle' };
        this.hint = null;
        this.render();
        return;
      case 'idle':
        void this.dispatch({ kind: 'pass' });
        return;
    }
  }

  /** Tapping mid-animation means impatience, not a lost input. */
  skipAnimation(): void {
    this.animator.skip();
  }

  /* --------------------------------------------------------------- modes */

  private chooseTarget(card: CardId): void {
    if (this.mode.kind !== 'targeting') return;
    const chosen = [...this.mode.chosen, card];
    const source = this.mode.card;

    const match = legalActions(this.state).find(
      a => a.kind === 'castSpell' && a.card === source && sameTargets(a.targets, chosen),
    );

    if (match) {
      this.mode = { kind: 'idle' };
      this.hint = null;
      void this.dispatch(match);
      return;
    }

    // Not a complete selection yet, but still on a legal path.
    const stillPossible = legalActions(this.state).some(
      a => a.kind === 'castSpell' && a.card === source && startsWith(a.targets, chosen),
    );
    if (stillPossible) {
      this.mode = { kind: 'targeting', card: source, chosen };
      this.render();
    } else {
      sound.play('illegal', { gain: 0.5 });
    }
  }

  private toggleAttacker(card: CardId): void {
    if (this.mode.kind !== 'attacking') return;
    if (inst(this.state, card).controller !== YOU) { this.zoom(card); return; }

    const canAttackWith = legalActions(this.state).some(
      a => a.kind === 'declareAttackers' && a.attackers.includes(card),
    );
    if (!canAttackWith) { sound.play('illegal', { gain: 0.5 }); return; }

    const picked = new Set(this.mode.picked);
    if (picked.has(card)) picked.delete(card);
    else { picked.add(card); sound.play('select'); }
    this.mode = { kind: 'attacking', picked };
    this.render();
  }

  private assignBlock(card: CardId): void {
    if (this.mode.kind !== 'blocking') return;
    const card_ = inst(this.state, card);

    // Tap your own creature to pick it up, then tap the attacker it should block.
    if (card_.controller === YOU) {
      const pairs = new Map(this.mode.pairs);
      if (pairs.has(card)) { pairs.delete(card); this.mode = { kind: 'blocking', blocker: null, pairs }; }
      else this.mode = { kind: 'blocking', blocker: card, pairs };
      sound.play('select');
      this.render();
      return;
    }

    if (!this.mode.blocker) { this.zoom(card); return; }
    if (!card_.attacking) { sound.play('illegal', { gain: 0.5 }); return; }

    const pairs = new Map(this.mode.pairs);
    pairs.set(this.mode.blocker, card);
    this.mode = { kind: 'blocking', blocker: null, pairs };
    sound.play('block', { gain: 0.6 });
    this.render();
  }

  private zoom(card: CardId): void {
    window.dispatchEvent(new CustomEvent('emteegee:zoom', { detail: { card, state: this.state } }));
  }

  /** Explains an unaffordable card rather than silently rejecting the tap. */
  private flashWhyNot(card: CardId): void {
    const d = def(this.state, card);
    const sorcerySpeed = !d.cardTypes.includes('instant') && !d.keywords.includes('flash');
    if (sorcerySpeed && this.state.phase !== 'main1' && this.state.phase !== 'main2') {
      this.hint = `<b>${d.name}</b> can only be played in your main phase.`;
    } else if (d.cardTypes.includes('land') && this.state.players[YOU].landPlayedThisTurn) {
      this.hint = 'One land per turn. You have already played yours.';
    } else {
      this.hint = `Not enough mana for <b>${d.name}</b> yet.`;
    }
    this.render();
    setTimeout(() => { this.hint = null; this.render(); }, 2600);
  }

  /* ------------------------------------------------------------- prompts */

  /**
   * Put the question the engine is waiting on in front of the player, if there is one.
   *
   * Three of the game's decisions arrive rather than being reached for: the opening
   * hand, the cards a scry looked at, and the order an attacker assigns damage in. Each
   * is asked from the same place — the state itself — rather than from whichever code
   * path happened to cause it, so a scry set up by a trigger and a scry set up by a
   * spell open the same panel by the same route.
   *
   * Called after every action and after the bot's turn. A prompt already open is left
   * alone: nothing can change the state underneath it, because answering it is the only
   * legal move there is.
   */
  private askIfNeeded(): void {
    if (this.prompt !== null) return;
    if (this.state.winner !== null) return;
    if (this.state.priority !== YOU) return;

    if (inMulligan(this.state)) {
      this.prompt = 'mulligan';
      this.prompts.mulligan(
        this.state, YOU,
        toBottom => this.answer({ kind: 'keepHand', toBottom }),
        () => this.answer({ kind: 'mulligan' }),
      );
      this.render();
      return;
    }

    if (this.state.pendingScry?.player === YOU) {
      this.prompt = 'scry';
      this.prompts.scry(this.state, toBottom => this.answer({ kind: 'scryDecision', toBottom }));
      this.render();
      return;
    }

    // Ordering hands priority to the defender (see `orderBlockers` in rules.ts), so at
    // most one attacker is ordered per combat and this asks about the first one the
    // generator offers. With two attackers each blocked twice, the second keeps the
    // order its blockers were declared in.
    const order = legalActions(this.state).find(a => a.kind === 'orderBlockers');
    if (order) {
      const attacker = order.attacker;
      this.prompt = 'order';
      this.prompts.blockerOrder(this.state, attacker, chosen =>
        this.answer({ kind: 'orderBlockers', attacker, order: chosen }));
      this.render();
    }
  }

  /** A panel reported its decision. The panel closed itself; this plays it. */
  private answer(action: Action): void {
    this.prompt = null;
    void this.dispatch(action);
  }

  /* ------------------------------------------------------------ the loop */

  private async dispatch(action: Action): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    try {
      const result = reduce(this.state, action);
      this.state = result.state;
      this.enterModeForPhase();
      this.animator.enqueue(result.events);
      this.render();
      await this.animator.idle();
    } catch (err) {
      // An illegal action reaching reduce() is a bug in this file, not user error.
      console.error('emteegee: rejected action', action, err);
      sound.play('illegal', { gain: 0.5 });
    } finally {
      this.busy = false;
    }

    if (this.state.winner !== null) {
      sound.play(this.state.winner === YOU ? 'win' : 'lose');
      this.onGameOver(this.state.winner);
      return;
    }

    // Before the bot runs: a mulligan and a scry both hand priority straight back, and
    // the player should see the next question rather than a table they cannot act on.
    this.askIfNeeded();
    await this.runBotIfNeeded();
  }

  private async runBotIfNeeded(): Promise<void> {
    let guard = 0;
    while (this.state.winner === null && this.state.priority === THEM) {
      if (++guard > 400) {
        console.error('emteegee: bot loop did not terminate');
        return;
      }

      const action = chooseAction(this.state, this.tier);
      const line = speechFor(this.state, action, this.tier);
      if (line) { this.speech = line; this.render(); }

      // A beat before acting reads as thinking, and gives the player time to see
      // what is about to happen rather than having it appear fully formed.
      await pause(this.speech ? 620 : 380);

      const result = reduce(this.state, action);
      this.state = result.state;
      this.enterModeForPhase();
      this.animator.enqueue(result.events);
      this.render();
      await this.animator.idle();
      this.speech = null;
    }

    this.render();
    if (this.state.winner !== null) {
      sound.play(this.state.winner === YOU ? 'win' : 'lose');
      this.onGameOver(this.state.winner);
      return;
    }

    // The Magician's block is what creates a damage order to choose, so the question
    // arrives here rather than out of anything the player did.
    this.askIfNeeded();
  }

  /** Phases that ask the player for a combat decision put them straight into it. */
  private enterModeForPhase(): void {
    if (this.state.phase === 'declareAttackers' && this.state.active === YOU) {
      if (this.mode.kind !== 'attacking') {
        this.mode = { kind: 'attacking', picked: new Set() };
        this.hint = hintFor('attacking');
      }
    } else if (this.state.phase === 'declareBlockers' && this.state.active === THEM) {
      if (this.mode.kind !== 'blocking') {
        this.mode = { kind: 'blocking', blocker: null, pairs: new Map() };
        this.hint = hintFor('blocking');
      }
    } else if (this.mode.kind === 'attacking' || this.mode.kind === 'blocking') {
      this.mode = { kind: 'idle' };
    }
  }

  /* ------------------------------------------------------------ rendering */

  private renderEvent(event: GameEvent): void {
    switch (event.type) {
      case 'DAMAGE':
        if (event.isPlayer) {
          this.table.floaty(`−${event.amount}`, 'damage', event.target === YOU ? 'you' : 'opponent');
        }
        break;
      case 'LIFE_CHANGE':
        if (event.to > event.from) {
          this.table.floaty(`+${event.to - event.from}`, 'gain', event.player === YOU ? 'you' : 'opponent');
        }
        break;
      default:
        break;
    }
    this.render();
  }

  /**
   * The table and whatever overlay is open are painted from the same state, in the same
   * call. A land tapped in the lands panel has to visibly tap *in that panel*, and the
   * only way that can never drift from the board behind it is for both to be a function
   * of the same `GameState` at the same moment.
   */
  private render(): void {
    this.table.patch(this.state, this.uiState());
    this.prompts.refresh(this.state);
  }

  private uiState(): UiState {
    return {
      you: YOU,
      selected: this.selectedCards(),
      targetable: this.targetableCards(),
      targetablePlayers: this.targetablePlayers(),
      blockingPairs: this.mode.kind === 'blocking' ? this.mode.pairs : new Map(),
      actLabel: this.actLabel(),
      actEnabled: this.actEnabled(),
      actHidden: this.prompt !== null,
      hint: this.hint,
      speech: this.speech,
    };
  }

  private selectedCards(): Set<CardId> {
    if (this.mode.kind === 'attacking') return new Set(this.mode.picked);
    if (this.mode.kind === 'blocking') {
      const set = new Set(this.mode.pairs.keys());
      if (this.mode.blocker) set.add(this.mode.blocker);
      return set;
    }
    return new Set();
  }

  /**
   * Players a spell can currently point at. `TargetSelection` models a player choice
   * as 'player0' / 'player1' rather than as a CardId, so this is a separate set from
   * the targetable permanents.
   */
  private targetablePlayers(): Set<PlayerId> {
    if (this.mode.kind !== 'targeting') return new Set();
    const source = this.mode.card;
    const players = new Set<PlayerId>();
    for (const action of legalActions(this.state)) {
      if (action.kind !== 'castSpell' || action.card !== source) continue;
      if (action.targets === 'player0') players.add(0);
      if (action.targets === 'player1') players.add(1);
    }
    return players;
  }

  private targetableCards(): Set<CardId> {
    if (this.mode.kind !== 'targeting') return new Set();
    const source = this.mode.card;
    const chosen = this.mode.chosen;
    const next = new Set<CardId>();

    for (const action of legalActions(this.state)) {
      if (action.kind !== 'castSpell' || action.card !== source) continue;
      if (!Array.isArray(action.targets)) continue;
      if (!startsWith(action.targets, chosen)) continue;
      const candidate = action.targets[chosen.length];
      if (candidate) next.add(candidate);
    }
    return next;
  }

  /**
   * The button always says exactly what the tap will do. This is the entire reason a
   * player can follow a real rules engine without knowing the phase structure.
   */
  private actLabel(): string {
    if (this.state.winner !== null) return 'Game over';
    if (this.state.priority === THEM) return 'The Magician is thinking';

    // A prompt is up: the panel in front of the player holds every move there is, and
    // the button must not offer one. `pass` is not even legal in two of these states.
    switch (this.prompt) {
      case 'mulligan': return 'Your opening hand';
      case 'scry': return 'Top or bottom';
      case 'order': return 'Choose the order';
      case null: break;
    }

    switch (this.mode.kind) {
      case 'targeting': return 'Cancel';
      case 'attacking': {
        const n = this.mode.picked.size;
        return n === 0 ? 'No attacks' : `Attack with ${n}`;
      }
      case 'blocking': {
        const n = this.mode.pairs.size;
        return n === 0 ? 'No blocks' : `Confirm ${n} block${n === 1 ? '' : 's'}`;
      }
      case 'idle': break;
    }

    if (this.state.stack.length > 0) return 'Pass';
    if (this.state.phase === 'main1') {
      const hasPlay = legalActions(this.state).some(a => a.kind === 'castSpell' || a.kind === 'playLand');
      return hasPlay ? 'Go to combat' : 'End turn';
    }
    if (this.state.phase === 'main2') return 'End turn';
    return 'Continue';
  }

  private actEnabled(): boolean {
    if (this.prompt !== null) return false;
    return this.state.winner === null && this.state.priority === YOU && !this.busy;
  }

  /** True while the engine, the animator, or an unanswered question owns the board. */
  private blocked(): boolean {
    if (this.animator.busy) { this.animator.skip(); return true; }
    if (this.prompt !== null) return true;
    return this.busy || this.state.winner !== null || this.state.priority !== YOU;
  }

  get gameState(): GameState {
    return this.state;
  }
}

/* ------------------------------------------------------------- utilities */

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function sameTargets(targets: TargetSelection, chosen: CardId[]): boolean {
  if (!Array.isArray(targets)) return chosen.length === 0;
  return targets.length === chosen.length && targets.every((t, i) => t === chosen[i]);
}

function startsWith(targets: TargetSelection, prefix: CardId[]): boolean {
  if (!Array.isArray(targets)) return prefix.length === 0;
  return prefix.every((p, i) => targets[i] === p);
}

/** Re-exported so screens can build a session without importing the engine directly. */
export { isCreature, opponentOf };
