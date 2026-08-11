/**
 * The shared type contract.
 *
 * Every module imports its shapes from here and none redefine them. Adding a
 * member to `Effect`, `Keyword`, or `TriggerEvent` widens what the game can
 * express and is therefore a spec change, not an implementation detail.
 */

export type PlayerId = 0 | 1;

/** Unique per instance on the table, e.g. "serra-angel#3". */
export type CardId = string;
/** Shared by every copy of a card, e.g. "serra-angel". */
export type OracleId = string;

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

/** `C` is generic mana, which any color may pay. */
export type ManaCost = Partial<Record<Color | 'C', number>>;

export type Keyword =
  | 'flying'
  | 'reach'
  | 'vigilance'
  | 'haste'
  | 'trample'
  | 'first strike'
  | 'double strike'
  | 'deathtouch'
  | 'lifelink'
  | 'menace'
  | 'defender'
  | 'ward'
  | 'hexproof'
  | 'flash';

export const ALL_KEYWORDS: readonly Keyword[] = [
  'flying', 'reach', 'vigilance', 'haste', 'trample', 'first strike',
  'double strike', 'deathtouch', 'lifelink', 'menace', 'defender',
  'ward', 'hexproof', 'flash',
];

export type CardType = 'creature' | 'instant' | 'sorcery' | 'enchantment' | 'artifact' | 'land';

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack';

export type Phase =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main1'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'firstStrikeDamage'
  | 'combatDamage'
  | 'endCombat'
  | 'main2'
  | 'end'
  | 'cleanup';

export const PHASE_ORDER: readonly Phase[] = [
  'untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers',
  'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat',
  'main2', 'end', 'cleanup',
];

/** The stack may never hold more than this many objects. See spec 3. */
export const STACK_CAP = 3;

export const STARTING_LIFE = 20;
export const STARTING_HAND = 7;
export const MAX_MULLIGANS = 3;

/**
 * Where an effect may point. Legality is resolved by actions.ts; the UI only
 * ever renders what `legalActions` already declared targetable.
 */
export interface TargetFilter {
  zone?: Zone;
  controller?: 'you' | 'opponent' | 'any';
  cardTypes?: CardType[];
  subtypes?: string[];
  colors?: Color[];
  minPower?: number;
  maxPower?: number;
  tapped?: boolean;
  attacking?: boolean;
  blocking?: boolean;
  /**
   * Negated constraints. Magic's classic removal is written in the negative
   * ("target nonblack creature", "target nonartifact creature") and a positive
   * whitelist cannot express it: listing the four other colors both catches
   * black multicolor creatures and wrongly excludes colorless ones.
   */
  notColors?: Color[];
  notCardTypes?: CardType[];
}

export type Duration = 'endOfTurn' | 'permanent';

/**
 * Who or what an effect resolves against.
 *
 * A bare `TargetFilter` means *one chosen target* matching it, resolved from the
 * selection the caster made. `{ every: filter }` means *every permanent that matches*,
 * with nothing to choose — the difference between Doom Blade and Wrath of God.
 *
 * Keeping those distinct is not pedantry: an unselected filter resolves to nothing, so
 * a mass effect written as a bare filter destroys nothing, pumps nothing, and looks
 * like it worked.
 *
 * `'any'` is Magic's "any target": a creature or a player, chosen by the caster when
 * the spell is cast. Without it no burn spell in the game is expressible, since every
 * one of them reads "deals N damage to any target".
 */
export type EffectTarget = TargetFilter | EveryTarget | 'self' | 'player' | 'any';

/** Every permanent matching the filter. Not targeted, so hexproof and ward do not apply. */
export interface EveryTarget {
  every: TargetFilter;
}

export const isEveryTarget = (target: EffectTarget): target is EveryTarget =>
  typeof target === 'object' && target !== null && 'every' in target;

/**
 * Effects that act on permanents rather than on players: one chosen permanent
 * matching a filter, or every permanent that matches.
 */
export type PermanentTarget = TargetFilter | EveryTarget;

/** Which player an effect acts on. `'target'` means the caster chooses. */
export type PlayerTarget = 'you' | 'opponent' | 'target';

/**
 * The closed effect vocabulary. `effects.ts` switches exhaustively over this
 * union, so adding a member without handling it fails to compile.
 */
export type Effect =
  | { kind: 'damage'; target: EffectTarget; amount: number }
  | { kind: 'destroy'; target: PermanentTarget }
  | { kind: 'exile'; target: PermanentTarget }
  | { kind: 'draw'; player: PlayerTarget; count: number }
  | { kind: 'discard'; player: PlayerTarget; count: number }
  | { kind: 'gainLife'; player: PlayerTarget; amount: number }
  | { kind: 'loseLife'; player: PlayerTarget; amount: number }
  | { kind: 'pump'; target: EffectTarget; power: number; toughness: number; duration: Duration }
  | { kind: 'grantKeyword'; target: EffectTarget; keyword: Keyword; duration: Duration }
  | { kind: 'tap'; target: PermanentTarget }
  | { kind: 'untap'; target: PermanentTarget }
  | { kind: 'addCounter'; target: EffectTarget; counter: CounterKind; count: number }
  | { kind: 'createToken'; token: TokenSpec; count: number }
  | { kind: 'scry'; count: number }
  | { kind: 'addMana'; colors: Color[] }
  | { kind: 'returnToHand'; target: PermanentTarget }
  | { kind: 'sacrifice'; target: PermanentTarget }
  | { kind: 'counterSpell' };

export type CounterKind = '+1/+1' | '-1/-1';

export interface TokenSpec {
  name: string;
  power: number;
  toughness: number;
  colors: Color[];
  subtypes: string[];
  keywords: Keyword[];
  art: string;
}

export type TriggerEvent =
  | 'onEnterBattlefield'
  /**
   * Any other creature entering, on either side of the table — never the entering
   * creature itself. Soul Warden and every lifegain engine hang off this, and they
   * count the opponent's creatures too.
   */
  | 'onOtherEnterBattlefield'
  | 'onDies'
  | 'onAttack'
  | 'onBlock'
  | 'onDealCombatDamage'
  | 'onUpkeep'
  | 'onCast'
  | 'onLifeGain';

export interface Trigger {
  on: TriggerEvent;
  effects: Effect[];
  /**
   * Targets this ability requires, chosen when it goes on the stack.
   *
   * A triggered ability picks its targets at a different moment than the spell that
   * created it, so it declares them here rather than on `CardDef.targets`.
   */
  targets?: TargetFilter[];
}

export type StaticAbility =
  | { kind: 'keyword'; keyword: Keyword }
  /** This creature cannot be declared as a blocker. */
  | { kind: 'cantBlock' }
  | {
      kind: 'staticPump';
      filter: TargetFilter;
      power: number;
      toughness: number;
      excludeSelf: boolean;
      /**
       * Keywords granted alongside the pump. Tribal lords almost always grant one
       * ("Other Goblins you control get +1/+1 and have haste"), and a lord that
       * silently drops the keyword half would have the engine refuse attacks the
       * real card allows.
       */
      keywords?: Keyword[];
    }
  | {
      kind: 'aura';
      attachTo: TargetFilter;
      power: number;
      toughness: number;
      keywords: Keyword[];
    };

export interface AbilityCost {
  mana?: ManaCost;
  tapSelf?: boolean;
  sacrificeSelf?: boolean;
}

export interface ActivatedAbility {
  cost: AbilityCost;
  effects: Effect[];
  sorcerySpeed: boolean;
  targets: TargetFilter[];
}

/** Static definition, one per oracle card. Never mutated. */
export interface CardDef {
  oracleId: OracleId;
  name: string;
  manaCost: ManaCost;
  cmc: number;
  colors: Color[];
  cardTypes: CardType[];
  subtypes: string[];
  power?: number;
  toughness?: number;
  oracleText: string;
  keywords: Keyword[];
  statics: StaticAbility[];
  triggers: Trigger[];
  activated: ActivatedAbility[];
  /** Instants and sorceries only. */
  spellEffects: Effect[];
  /** One entry per required target, in the order the player chooses them. */
  targets: TargetFilter[];
  /** Ward cost, when the card has the ward keyword. */
  wardCost?: ManaCost;
  artist: string;
  art: string;
  image: string;
  /** Lands only. */
  producesMana?: Color[];
}

/** A specific instance on the table. Only `reduce()` may change one. */
export interface CardInstance {
  id: CardId;
  oracleId: OracleId;
  controller: PlayerId;
  owner: PlayerId;
  zone: Zone;
  tapped: boolean;
  summonedThisTurn: boolean;
  damage: number;
  counters: Record<CounterKind, number>;
  /** Cleared at cleanup. */
  tempPump: { power: number; toughness: number };
  /** Cleared at cleanup. */
  tempKeywords: Keyword[];
  /** Auras only: the permanent this is attached to. */
  attachedTo?: CardId;
  /** Tokens cease to exist when they leave the battlefield. */
  isToken: boolean;
  tokenSpec?: TokenSpec;
  attacking: boolean;
  /** The attacker this creature is blocking. */
  blocking?: CardId;
  /** Blockers assigned to this attacker, in damage-assignment order. */
  blockedBy: CardId[];
  /**
   * Whether this attacker's controller has already chosen that order.
   *
   * Needed because "already decided" is otherwise unrepresentable, and the priority
   * handoff was standing in for it — which capped the whole combat at one ordered
   * attacker. Cleared when combat ends, along with the rest of the combat state.
   */
  damageOrderChosen: boolean;
}

export interface PlayerState {
  id: PlayerId;
  life: number;
  library: CardId[];
  hand: CardId[];
  battlefield: CardId[];
  graveyard: CardId[];
  exile: CardId[];
  landPlayedThisTurn: boolean;
  manaPool: Partial<Record<Color | 'C', number>>;
  mulligansTaken: number;
  /** Set when a draw was attempted from an empty library. */
  drewFromEmpty: boolean;
}

export interface StackObject {
  id: string;
  source: CardId;
  controller: PlayerId;
  effects: Effect[];
  targets: TargetSelection;
  isTriggered: boolean;
}

/** What a spell or ability points at. */
export type TargetSelection = CardId[] | 'player0' | 'player1' | null;

export interface GameState {
  cards: Record<CardId, CardInstance>;
  defs: Record<OracleId, CardDef>;
  players: [PlayerState, PlayerState];
  /** Whose turn it is. */
  active: PlayerId;
  /** Who may act right now. */
  priority: PlayerId;
  turn: number;
  phase: Phase;
  stack: StackObject[];
  winner: PlayerId | null;
  rngSeed: number;
  /** Monotonic, so generated ids never collide. */
  nextId: number;
  /**
   * True while a triggered ability resolves. A trigger may not enqueue another
   * trigger; this flag is the structural guard against loops.
   */
  resolvingTrigger: boolean;
  /** Set when a scry is awaiting the controller's decision. */
  pendingScry: { player: PlayerId; cards: CardId[] } | null;
}

export type Action =
  | { kind: 'playLand'; card: CardId }
  | { kind: 'castSpell'; card: CardId; targets: TargetSelection }
  | { kind: 'activate'; card: CardId; abilityIndex: number; targets: TargetSelection }
  | { kind: 'declareAttackers'; attackers: CardId[] }
  | { kind: 'declareBlockers'; blocks: BlockAssignment[] }
  | { kind: 'orderBlockers'; attacker: CardId; order: CardId[] }
  | { kind: 'scryDecision'; toBottom: CardId[] }
  | { kind: 'mulligan' }
  | { kind: 'keepHand'; toBottom: CardId[] }
  | { kind: 'tapLand'; card: CardId }
  | { kind: 'pass' };

export interface BlockAssignment {
  blocker: CardId;
  attacker: CardId;
}

export type GameEvent =
  | { type: 'DRAW'; player: PlayerId; card: CardId }
  | { type: 'PLAY'; player: PlayerId; card: CardId }
  | { type: 'CAST'; player: PlayerId; card: CardId; targets: TargetSelection }
  | { type: 'RESOLVE'; card: CardId }
  | { type: 'COUNTERED'; card: CardId }
  | { type: 'TAP'; card: CardId }
  | { type: 'UNTAP'; card: CardId }
  | { type: 'ATTACK'; attackers: CardId[] }
  | { type: 'BLOCK'; blocker: CardId; attacker: CardId }
  | { type: 'DAMAGE'; source: CardId; target: CardId; amount: number; isPlayer: false }
  | { type: 'DAMAGE'; source: CardId; target: PlayerId; amount: number; isPlayer: true }
  | { type: 'DIE'; card: CardId }
  | { type: 'LIFE_CHANGE'; player: PlayerId; from: number; to: number }
  | { type: 'COUNTER_ADD'; card: CardId; counter: CounterKind; count: number }
  | { type: 'TOKEN_CREATE'; card: CardId }
  | { type: 'ZONE_CHANGE'; card: CardId; from: Zone; to: Zone }
  | { type: 'SCRY'; player: PlayerId; count: number }
  | { type: 'PHASE'; phase: Phase; active: PlayerId; turn: number }
  | { type: 'TRIGGER'; source: CardId; on: TriggerEvent }
  | { type: 'WIN'; player: PlayerId };

export interface ReduceResult {
  state: GameState;
  events: GameEvent[];
}

/** Exhaustiveness guard for switches over closed unions. */
export function assertNever(x: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(x)}`);
}
