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
import { STACK_CAP } from '../engine/types';
import { def, inst, isCreature, opponentOf, powerOf } from '../engine/state';
import { inMulligan, legalActions } from '../engine/actions';
import { reduce } from '../engine/rules';
import { chooseAction, type Tier } from '../bot/magician';
import { speechFor } from '../bot/personality';
import { Animator } from './animator';
import type { DropTarget } from './gestures';
import { sound } from '../audio/kit';
import type { ResolveDest, TableView, UiState } from './table';
import type { PromptView } from './overlay';
import { hintFor } from './hints';

export const YOU: PlayerId = 0;
export const THEM: PlayerId = 1;

/** What the player is in the middle of doing. Purely presentational. */
type Mode =
  | { kind: 'idle' }
  | { kind: 'targeting'; card: CardId; chosen: CardId[] }
  /** A hand card mid-drag: every legal destination glows until it lands. */
  | { kind: 'dragging'; card: CardId; over: DropTarget }
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
  /** Sources dealing damage in the batch now playing — their resolution ghost defers
   *  to the bolt, so one event is not explained by two ghosts at once. */
  private damageSources = new Set<CardId>();

  constructor(opts: SessionOptions) {
    this.state = opts.initial;
    this.table = opts.table;
    this.prompts = opts.prompts;
    this.tier = opts.tier;
    this.onGameOver = opts.onGameOver;
    this.animator = new Animator((event, instant) => this.renderEvent(event, instant));
  }

  start(): void {
    this.render();
    this.askIfNeeded();
    void this.runBotIfNeeded();
  }

  /* ------------------------------------------------------------- intents */

  /**
   * A card in hand, tapped: play it.
   *
   * One legal way to play it means no decision to present — it happens. Several legal
   * targets means the player aims next (or they could have dragged it onto the target
   * in one motion, which is the primary path). Reading lives on long-press, so the
   * most common action in the game costs exactly one tap again.
   */
  handTap(card: CardId): void {
    if (this.blocked()) return;
    sound.unlock();

    // Mid-targeting, a tap on the card being aimed means "never mind".
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

    if (options.length === 0) {
      sound.play('illegal', { gain: 0.5 });
      this.flashWhyNot(card);
      return;
    }

    if (options.length === 1) {
      void this.dispatch(options[0]!);
      return;
    }

    this.mode = { kind: 'targeting', card, chosen: [] };
    this.hint = hintFor('targeting');
    sound.play('select');
    this.render();
  }

  /**
   * Any card held still — in the fan, on the battlefield, in a panel: the reader,
   * committing to nothing. Long press is THE reading gesture; a tap is always the
   * act. Reading is not a move, so this is not gated on priority or animation.
   */
  peek(card: CardId): void {
    if (!this.state.cards[card]) return;
    this.prompts.read(this.state, card, []);
  }

  /**
   * A drag has left the fan: light everywhere this card may go.
   *
   * The sets come from `legalActions`, the same as every other affordance — a glowing
   * drop target is a promise the engine will accept the drop.
   */
  dragStart(card: CardId): void {
    if (this.blocked()) return;
    sound.unlock();
    this.mode = { kind: 'dragging', card, over: { kind: 'nowhere' } };
    sound.play('select', { gain: 0.5 });
    this.render();
  }

  /**
   * The finger moved over a different drop target.
   *
   * Every legal target glowing says where the card MAY go. It does not say where THIS
   * release will send it — the only question left at the moment of letting go — so the
   * one under the finger is marked separately, and ticks when it changes.
   */
  dragOver(_card: CardId, target: DropTarget): void {
    if (this.mode.kind !== 'dragging') return;
    const was = this.mode.over;
    this.mode = { ...this.mode, over: target };
    const wasReal = was.kind === 'card' || was.kind === 'player';
    const isReal = target.kind === 'card' || target.kind === 'player';
    if (isReal && !(wasReal && sameTarget(was, target))) sound.play('blip', { gain: 0.3 });
    this.render();
  }

  /**
   * The dragged card was let go.
   *
   * Dropping on a specific thing casts at that thing. Dropping "on the table" plays
   * the card its one untargeted way — a land, a creature, a global spell. A targeted
   * spell dropped on open felt springs back rather than guessing its target for it.
   */
  drop(card: CardId, target: DropTarget): void {
    this.mode = { kind: 'idle' };

    // Deliberately NOT gated on this session having registered the drag. A drag that
    // begins while the animator is still running never reaches `dragStart` — `blocked()`
    // turns it away and fast-forwards instead — yet the card follows the finger the
    // whole way regardless, because the gesture layer has no idea it was refused. The
    // player completes a gesture and the game throws it away without a sound.
    //
    // The gesture layer is the authority on "a drag happened". Whether the card may be
    // PLAYED is decided by `legalActions` below, which is the guard every other path
    // already trusts — so nothing illegal gets through by loosening this.
    const options = legalActions(this.state).filter(
      a => (a.kind === 'castSpell' || a.kind === 'playLand') && a.card === card,
    );

    const untargeted = options.find(
      a => a.kind === 'playLand' || (a.kind === 'castSpell' && a.targets === null),
    );

    let chosen: Action | undefined;
    switch (target.kind) {
      case 'card':
        chosen = options.find(a =>
          a.kind === 'castSpell' && Array.isArray(a.targets) &&
          a.targets.length === 1 && a.targets[0] === target.id);
        // A land released over a creature is not aiming at it — nothing a land does
        // takes a target. Any drop on the table plays an untargeted card; precision
        // is only demanded of the cards that actually point at something.
        chosen ??= untargeted;
        break;
      case 'player': {
        const wanted = target.id === 0 ? 'player0' : 'player1';
        chosen = options.find(a => a.kind === 'castSpell' && a.targets === wanted);
        // The band directly above the fan is YOUR OWN RAIL, so this is where every
        // short drag ends. A land released there sprang back — the drop zone glowed
        // and then refused the drop, which reads as broken rather than as strict.
        chosen ??= untargeted;
        break;
      }
      case 'board':
        chosen = untargeted;
        break;
      case 'nowhere':
        // Released back in the fan: that is the cancel gesture, and it stays one.
        break;
    }

    if (chosen) {
      // The tick lands with the card, not after the engine has finished thinking about
      // it — the hand felt the release, so the confirmation belongs at the release.
      buzz(9);
      void this.dispatch(chosen);
      return;
    }

    // Sprung back. Say why when the card was unplayable outright; a targeted spell
    // dropped on nothing just settles home, since the glow already said where it goes.
    if (target.kind !== 'nowhere' && options.length === 0) {
      sound.play('illegal', { gain: 0.5 });
      // Two short knocks rather than one: the same "no" the phone gives everywhere
      // else, so a refusal is distinguishable from a play by feel alone.
      buzz([0, 26, 60, 26]);
      this.flashWhyNot(card);
    } else {
      sound.play('blip', { gain: 0.4 });
      this.render();
    }
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
        // Deliberately nothing. A tap is the acting gesture and there is nothing to
        // act on here; reading goes through long press, same as everywhere else.
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
    if (inst(this.state, card).controller !== YOU) return;

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

    if (!this.mode.blocker) return;
    if (!card_.attacking) { sound.play('illegal', { gain: 0.5 }); return; }

    const pairs = new Map(this.mode.pairs);
    pairs.set(this.mode.blocker, card);
    this.mode = { kind: 'blocking', blocker: null, pairs };
    sound.play('block', { gain: 0.6 });
    this.render();
  }

  /** Explains an unaffordable card rather than silently rejecting the tap. */
  private flashWhyNot(card: CardId): void {
    // The shake goes on before the hint, so the card answers in the same beat the
    // finger let go rather than a frame behind the sentence explaining it.
    this.table.refuse(card);

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
      this.present(result.events);
      this.render();
      await this.animator.idle();
      this.table.releaseHeld();
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

      // The thinking beat belongs to plays worth watching. A spell or an attack gets
      // one — that pause is what makes a bomb feel considered rather than dispensed —
      // but passes, land drops and bookkeeping do not, because eight of those beats
      // in a row is not an opponent thinking, it is a player waiting.
      const notable =
        action.kind === 'castSpell' ||
        action.kind === 'declareAttackers' ||
        action.kind === 'declareBlockers' ||
        action.kind === 'activate';
      if (this.speech) await pause(620);
      else if (notable) await pause(340);
      else await pause(60);

      const result = reduce(this.state, action);
      this.state = result.state;
      this.enterModeForPhase();
      this.present(result.events);
      this.render();
      await this.animator.idle();
      this.table.releaseHeld();
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

  /**
   * Hand a batch of events to the animator, with everything the beats will need
   * prepared first: a snapshot of where every node currently is (the repaint jumps
   * straight to the final state, so "where things were" exists only now), the doomed
   * held on the board until their DIE beat, and a note of which sources deal damage.
   */
  private present(events: readonly GameEvent[]): void {
    this.table.snapshot();
    this.table.holdForDeaths(events.flatMap(e => (e.type === 'DIE' ? [e.card] : [])));
    this.damageSources = new Set(events.flatMap(e => (e.type === 'DAMAGE' ? [e.source] : [])));
    this.animator.enqueue(events);
  }

  private renderEvent(event: GameEvent, instant: boolean): void {
    // Paint the new state first: strikes and flights aim at nodes this patch creates,
    // while their starting points come from the snapshot taken before the batch.
    this.render();

    switch (event.type) {
      case 'PHASE':
        // Only the untap step, which is the one phase that is unambiguously "a new
        // turn started". Announcing every phase would make the banner wallpaper.
        if (event.phase === 'untap') {
          this.table.banner(event.active === YOU ? 'Your turn' : 'The Magician');
        }
        break;

      case 'DRAW':
        if (!instant) this.table.flyDraw(event.player === YOU, event.card);
        break;

      case 'PLAY':
        // Lands are the only thing PLAYed, and their new home is the mana row —
        // watching the card become a pill teaches the row's whole abstraction.
        if (!instant) this.table.flyPlay(event.card, this.imageOf(event.card), event.player === YOU);
        break;

      case 'CAST': {
        if (instant) break;
        const you = event.player === YOU;
        const image = this.imageOf(event.card);
        if (this.state.stack.some(o => o.source === event.card)) {
          this.table.flyFromHand(event.card, image, you, 'stack');
          break;
        }
        // Nothing could respond, so the spell resolved in the same batch it was cast
        // and the stack moment never reaches the screen. The card travels straight
        // from the hand to wherever it ended up instead.
        const card = this.state.cards[event.card];
        if (!card) break;
        if (card.zone === 'battlefield') this.table.flyFromHand(event.card, image, you, 'board');
        else if (this.damageSources.has(event.card)) break; // the bolt tells this story
        else if (card.zone === 'graveyard' && card.owner === YOU) {
          this.table.flyFromHand(event.card, image, you, 'grave');
        } else this.table.flyFromHand(event.card, image, you, 'mid');
        break;
      }

      case 'RESOLVE': {
        if (instant) break;
        const card = this.state.cards[event.card];
        if (!card) break;
        // A spell about to deal damage tells its story with the bolt; sending its
        // card to the graveyard at the same moment would be two ghosts for one event.
        if (card.zone !== 'battlefield' && this.damageSources.has(event.card)) break;
        const dest: ResolveDest =
          card.zone === 'battlefield'
            ? { kind: 'battlefield', attachedTo: card.attachedTo ?? null }
            : card.zone === 'graveyard' && card.owner === YOU
              ? { kind: 'grave' }
              : { kind: 'away' };
        this.table.flyResolve(event.card, this.artOf(event.card), dest);
        break;
      }

      case 'COUNTERED':
        if (!instant) this.table.fizzle(event.card, this.artOf(event.card));
        break;

      case 'TRIGGER':
        // The ring answers "why did that just happen" by pointing at the card that
        // did it — the single most opaque moment for someone new to triggers.
        if (!instant) this.table.pulse(event.source);
        break;

      case 'COUNTER_ADD':
        if (!instant) this.table.pulse(event.card);
        break;

      case 'DIE':
        this.table.perish(event.card, {
          instant,
          toGrave: this.state.cards[event.card]?.owner === YOU,
        });
        break;

      case 'DAMAGE': {
        if (instant) {
          if (!event.isPlayer) this.table.clash(event.target);
          else {
            this.table.floaty(`−${event.amount}`, 'damage', event.target === YOU ? 'you' : 'opponent');
            if (event.target === YOU) buzz(Math.min(60, 12 + event.amount * 6));
          }
          break;
        }
        // Directed: the source pecks at exactly what it hit, and the impact —
        // ring, flash, number, buzz — lands at the moment of contact.
        const contact = this.table.strike(
          event.source,
          event.isPlayer
            ? { kind: 'rail', you: event.target === YOU }
            : { kind: 'tile', id: event.target },
          this.state.cards[event.source]?.controller === YOU,
        );
        if (event.isPlayer) {
          const anchor = event.target === YOU ? 'you' : 'opponent';
          const mine = event.target === YOU;
          setTimeout(() => {
            this.table.floaty(`−${event.amount}`, 'damage', anchor);
            // Only damage YOU take, and only in proportion to it. A phone that
            // buzzes at everything is a phone the player mutes.
            if (mine) buzz(Math.min(60, 12 + event.amount * 6));
          }, contact);
        }
        break;
      }

      case 'LIFE_CHANGE':
        if (event.to > event.from) {
          this.table.floaty(`+${event.to - event.from}`, 'gain', event.player === YOU ? 'you' : 'opponent');
        }
        break;

      default:
        break;
    }
  }

  /** The full card face, for ghosts leaving a hand. */
  private imageOf(card: CardId): string {
    const instance = this.state.cards[card];
    if (!instance) return '';
    if (instance.isToken) return instance.tokenSpec?.art ?? '';
    return this.state.defs[instance.oracleId]?.image ?? '';
  }

  /** The art crop, for ghosts matching a stack row or a board tile. */
  private artOf(card: CardId): string {
    const instance = this.state.cards[card];
    if (!instance) return '';
    if (instance.isToken) return instance.tokenSpec?.art ?? '';
    return this.state.defs[instance.oracleId]?.art ?? '';
  }

  /**
   * The table and whatever overlay is open are painted from the same state, in the same
   * call. A land tapped in the lands panel has to visibly tap *in that panel*, and the
   * only way that can never drift from the board behind it is for both to be a function
   * of the same `GameState` at the same moment.
   */
  private render(): void {
    this.noticeStack();
    this.table.patch(this.state, this.uiState());
    this.prompts.refresh(this.state);
  }

  /**
   * Teach the stack at the first moment it is worth teaching.
   *
   * Two objects at once is when the rule actually bites: the player cast something, it
   * did not happen, and the thing sitting on top of it is about to go first. Explaining
   * last-in-first-out before that has nothing to point at.
   */
  private noticeStack(): void {
    if (this.hint !== null) return;
    if (this.state.stack.length >= STACK_CAP) {
      this.hint = hintFor('stackFull');
      return;
    }
    if (this.state.stack.length >= 2) this.hint = hintFor('stackOrder');
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
      incoming: this.incomingDamage(),
      boardDrop: this.boardDroppable(),
      landDrop: this.landDroppable(),
      over: this.mode.kind === 'dragging' ? this.mode.over : null,
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
  /** True while a dragged card could be played with no target: the felt itself glows. */
  private boardDroppable(): boolean {
    if (this.mode.kind !== 'dragging') return false;
    const source = this.mode.card;
    return legalActions(this.state).some(
      a => (a.kind === 'playLand' && a.card === source) ||
           (a.kind === 'castSpell' && a.card === source && a.targets === null),
    );
  }

  /**
   * True while the dragged card is a land: the mana row lights up as its own drop
   * zone. Lands do not go where creatures go — they become the row of mana — and a
   * drop zone that shows where the card will END UP teaches the mana row's whole
   * abstraction in one gesture.
   */
  private landDroppable(): boolean {
    if (this.mode.kind !== 'dragging') return false;
    const source = this.mode.card;
    if (!def(this.state, source).cardTypes.includes('land')) return false;
    return legalActions(this.state).some(a => a.kind === 'playLand' && a.card === source);
  }

  private targetablePlayers(): Set<PlayerId> {
    const source =
      this.mode.kind === 'targeting' || this.mode.kind === 'dragging' ? this.mode.card : null;
    if (source === null) return new Set();
    const players = new Set<PlayerId>();
    for (const action of legalActions(this.state)) {
      if (action.kind !== 'castSpell' || action.card !== source) continue;
      if (action.targets === 'player0') players.add(0);
      if (action.targets === 'player1') players.add(1);
    }
    return players;
  }

  /**
   * How much damage would get through if blocks were confirmed as they stand.
   *
   * Only while blocks are actually being assigned — outside that window the number
   * would be a prediction about a decision nobody is making, which is noise.
   *
   * Counts an attacker as unblocked when nothing in the current assignment names it,
   * so the figure falls as each blocker is committed and the player watches their own
   * decision pay off. Trample is deliberately not modelled: the point here is to teach
   * "blocking stops damage", and a number that only partly moves when you block
   * teaches something muddier.
   */
  private incomingDamage(): { player: PlayerId; amount: number } | null {
    if (this.mode.kind !== 'blocking') return null;

    const blocked = new Set(this.mode.pairs.values());
    let amount = 0;
    for (const id of this.state.players[THEM].battlefield) {
      const card = inst(this.state, id);
      if (!card.attacking || blocked.has(id)) continue;
      amount += powerOf(this.state, id);
    }

    return amount > 0 ? { player: YOU, amount } : null;
  }

  private targetableCards(): Set<CardId> {
    if (this.mode.kind === 'dragging') {
      const source = this.mode.card;
      const set = new Set<CardId>();
      for (const action of legalActions(this.state)) {
        if (action.kind !== 'castSpell' || action.card !== source) continue;
        if (Array.isArray(action.targets) && action.targets.length === 1) set.add(action.targets[0]!);
      }
      return set;
    }
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
    if (this.state.priority === THEM) return 'Thinking…';

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

/** Are these the same drop target? Used to keep the hover tick from stuttering. */
function sameTarget(a: DropTarget, b: DropTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'card' && b.kind === 'card') return a.id === b.id;
  if (a.kind === 'player' && b.kind === 'player') return a.id === b.id;
  return true;
}

/* ------------------------------------------------------------- utilities */

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Haptics, where the device has them and the player has not asked for stillness.
 *  A pattern (`[wait, buzz, wait, buzz]`) is how a refusal says no twice. */
function buzz(ms: number | number[]): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not supported, or blocked. Never worth surfacing.
  }
}

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
