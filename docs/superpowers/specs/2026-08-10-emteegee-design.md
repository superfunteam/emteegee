# emteegee — design spec

**Date:** 2026-08-10
**Status:** approved, ready for implementation planning

## 1. What this is

A single-player Magic: The Gathering game that runs in a mobile browser. You pick one of six
themed decks and play one game against The Magician, a bot with three difficulty tiers.

The product is the match. There is no account, no collection, no deckbuilder, no ladder.

Two commitments shape every decision below:

1. **Native-app feel on a phone.** 60fps, real touch gestures, sound on every meaningful event,
   and a table that stays legible when the board is full.
2. **A real rules engine at a beginner's pace.** The rules underneath are genuine Magic —
   a stack, priority, state-based actions, correct combat damage. What makes it beginner-level
   is the *card pool* and the *pacing*, not a watered-down engine.

### Non-goals

- Multiplayer, networking, or any server. The game is a static bundle.
- Deckbuilding or card collection.
- Formats, sideboards, best-of-three, tournaments.
- Planeswalkers, sagas, modal double-faced cards, or any non-standard card layout.
- Infinite or near-infinite combos. The stack cap makes these structurally impossible.

## 2. Decision record

Every decision below was settled during the design interview and is treated as fixed.
Reopening one is a spec change, not an implementation detail.

| Area | Decision |
|---|---|
| Rules depth | Full stack with LIFO resolution, hard-capped at 3 objects |
| Keywords | Core ten + double strike, ward, hexproof + flash, scry + counters and tokens |
| Card pool | ~250 hand-picked all-time-classic cards, validated at build time |
| Decks | Six: three mono-color, three two-color; 60 cards each, ~24 lands |
| Table layout | Art tiles for creatures, mana gem row for lands, tap for the real card |
| Mana | Auto-tap on cast, long-press the mana row for manual control |
| Bot | Three tiers over one shared evaluator, with personality on top |
| Stack | TypeScript + Vite, no framework |
| Sound | Kenney CC0 sample packs |
| Attack gesture | Tap to select attackers, swipe up as a shortcut |
| Session | One game, pick deck, rematch |
| Skins | Parchment, Slate, Felt — three ship, Felt is default |
| Pacing | Always tap to advance; skip stops where advancing is the only legal action |
| Teaching | Contextual dismissible hints, no upfront tutorial |
| Card art | Bundled in the repo (rights confirmed by the project owner) |

## 3. Rules scope

### In

- Turn structure: untap, upkeep, draw, precombat main, combat, postcombat main, end, cleanup.
- Priority and a stack capped at 3 objects.
- State-based actions: lethal damage, zero toughness, player at 0 life, empty library on draw.
- Combat: declare attackers, declare blockers, first-strike damage step, regular damage step,
  ordered damage assignment, trample spillover.
- Card types: creature, instant, sorcery, enchantment (aura and static only), artifact, land.
- Keywords: flying, reach, vigilance, haste, trample, first strike, double strike, deathtouch,
  lifelink, menace, defender, ward, hexproof, flash.
- Scry, +1/+1 and -1/-1 counters, creature tokens.
- Mulligan: London mulligan, capped at three.
- One land drop per turn, 20 starting life, 7-card opening hand.
- **The human player is always on the play** and therefore skips their first draw. This is a
  deliberate beginner concession, not an oversight: being on the play is a real advantage, and
  handing it to the player every game removes a source of losses they cannot understand yet.
  The Magician is always on the draw and gets the extra card.

### Out

Anything not listed above does not exist in this game, and the build-time validator enforces it.
Explicitly excluded: planeswalkers, the graveyard as a resource (no flashback, no recursion),
tutoring, milling, alternate win conditions, mana abilities beyond basic lands, split/adventure/
modal cards, replacement effects, protection, regeneration, and any triggered ability that
triggers off another trigger.

### The stack cap

The cap counts **all** objects on the stack, including the original spell. So a spell plus two
responses fills it: cast, respond, respond-to-the-response, done. When the stack holds three
objects, no further responses are legal — the response affordance disables and reads "the stack
is full". This is a visible, explained rule, not a silent failure. It makes unbounded chains
structurally impossible rather than merely unlikely.

## 4. Architecture

### 4.1 The core decision: an event-sourced engine

```
reduce(state, action) -> { state: GameState, events: GameEvent[] }
```

The engine is a pure function. It has no knowledge of the DOM, timers, animation, or audio.
The UI subscribes to the emitted events and plays them on a timeline.

**The UI never mutates state. The engine never waits for animation.**

This one constraint buys four things:

- Engine tests run in milliseconds with no DOM and no fake timers.
- The bot searches by calling the same reducer it plays through, so it can never
  consider a move the rules would reject.
- Animation cannot desync from state, because it is strictly downstream of it.
- Replay and undo are free — a game is its action log.

### 4.2 Data flow

```
tap / swipe
    -> Intent
    -> actions.isLegal(state, action)      (illegal intents are dropped at the boundary)
    -> engine.reduce(state, action)
    -> { newState, events[] }
         |                    |
         |                    +-> animator.enqueue(events) -> DOM patch + audio
         +-> store.commit(newState)
    -> if the active player is the bot: bot.choose(state) -> engine.reduce(...)
```

### 4.3 Modules

Each module is independently testable and has one job. None of the engine modules import
anything from `ui/` or `audio/`.

| Module | Responsibility |
|---|---|
| `engine/state.ts` | The serializable `GameState`. Zones, players, turn, phase, priority, stack. |
| `engine/cards.ts` | Card definitions: data plus declarative effect descriptors. Never arbitrary code. |
| `engine/actions.ts` | Legal-action generator. `legalActions(state) -> Action[]`. |
| `engine/effects.ts` | Interpreter for the closed effect vocabulary (section 5). |
| `engine/combat.ts` | Attack and block declaration, damage assignment, damage steps. |
| `engine/rules.ts` | Turn/phase advancement, priority, stack resolution, state-based actions. |
| `engine/events.ts` | `GameEvent` types and constructors. |
| `bot/evaluate.ts` | Board evaluation. One function, shared by all three tiers. |
| `bot/magician.ts` | The three tiers. |
| `bot/personality.ts` | Speech lines keyed to game events, drawn from a shuffle bag. |
| `ui/table.ts` | Table composition and zone layout. |
| `ui/card.ts` | Card tile, full-card overlay, token rendering. |
| `ui/hand.ts` | The fanned hand, drag/swipe handling. |
| `ui/rail.ts` | Player info rails: life, hand count, library count, turn indicator. |
| `ui/mana.ts` | Mana gem row, long-press to expand real lands. |
| `ui/stack.ts` | The stack display and response windows. |
| `ui/animator.ts` | Event queue to timeline. Owns all timing. |
| `ui/hints.ts` | Contextual first-time hints and their persistence. |
| `audio/kit.ts` | Pooled Web Audio wrapper, mute toggle, per-event sound mapping. |
| `decks/*.ts` | Six deck lists. |
| `tools/build-pool.ts` | Scryfall resolution and whitelist validation. |
| `tools/fetch-art.ts` | Art download into `public/art/`. |

`legalActions` is deliberately load-bearing: it drives what the UI makes tappable, what the bot
can consider, and what the tests assert against. There is exactly one definition of "legal".

### 4.4 The single most important invariant

> Any state the UI can produce, the bot can also produce, and the tests can construct directly.

If a code path exists only for the human player, it is a bug.

## 5. The effect vocabulary

Cards are data. A card's behavior is a list of descriptors drawn from this closed set. Adding a
card never means writing new code; adding a *mechanic* means extending this list deliberately.

### Effects

`damage` · `destroy` · `exile` · `draw` · `discard` · `gainLife` · `loseLife` · `pump`
`grantKeyword` · `tap` · `untap` · `addCounter` · `createToken` · `scry` · `addMana`
`returnToHand` · `sacrifice` · `counterSpell`

`counterSpell` exists in the vocabulary but **no card in the six starter decks uses it.** Blue's
beginner-facing counterspells teach "your turn did nothing", which is the worst possible first
experience. The effect is implemented so the pool can grow later.

### Triggers

`onEnterBattlefield` · `onDies` · `onAttack` · `onBlock` · `onDealCombatDamage`
`onUpkeep` · `onCast` · `onLifeGain`

A trigger may not enqueue another trigger. This is enforced by the effect interpreter and is the
second structural guard against loops.

### Static abilities

`keyword` (from the evergreen list) · `staticPump` (lord effects, e.g. "other Soldiers get +1/+1")
`aura` (attached to a permanent; grants `staticPump` and/or `keyword` to its host)

An aura enters attached to a legal target chosen on cast. If its host leaves the battlefield, the
aura is put into its owner's graveyard by state-based action. Auras may not target a permanent
with hexproof controlled by an opponent, and pay ward costs as any other targeting does.

### Activated abilities

`{ cost: ManaCost + tap? + sacrifice?, effect: Effect[] }`

### Targeting

`TargetFilter { zone, controller, cardTypes, subtypes, colors, minPower, maxPower, tapped }`

Targeting legality (ward, hexproof, "can't be blocked by") is resolved by `actions.ts`, never by
the UI. The UI only ever renders what `legalActions` already told it is targetable.

## 6. Combat

The correct algorithm, simplified only where the rules scope allows.

1. **Declare attackers.** Untapped, non-defender, no summoning sickness unless haste. Attackers
   without vigilance tap. Fire `onAttack`.
2. **Priority window.** Instants and flash. Skipped if neither player has a legal response.
3. **Declare blockers.** Each blocker blocks exactly one attacker. Flying may only be blocked by
   flying or reach. Menace requires at least two blockers. Fire `onBlock`.
4. **Priority window.**
5. **First-strike damage step.** Runs only if at least one creature has first or double strike.
6. **Regular damage step.** Double strikers deal damage again.
7. **Damage assignment.** An attacker assigns lethal damage to each blocker in the defender's
   chosen order before assigning to the next. With trample, excess spills to the player.
   With deathtouch, one damage counts as lethal for assignment purposes.
8. **State-based actions.** Creatures with damage ≥ toughness, or toughness ≤ 0, die.
9. Fire `onDealCombatDamage`. Lifelink resolves here, on damage — not on cast.

### Blocking on a touch screen

Tap your creature — it lifts. Tap the attacker it should block — a connector line draws between
them. Tap the lifted creature again to cancel. The primary button reads `Confirm blocks`.

Unblocked attackers are visually marked with a strike-through path to your life total so the
incoming damage is obvious before you commit.

## 7. The Magician

All three tiers use the same `legalActions` generator and the same `evaluate` function. They
differ only in search depth and noise.

### Evaluation

```
score =  (myLife - oppLife) * 2
       + sum(my board: power + toughness + keywordValue)
       - sum(their board: power + toughness + keywordValue)
       + myHandSize * 1.5
       + myUntappedLands * 0.5
```

`keywordValue` is a fixed lookup, not a heuristic to be tuned per tier: evasion (flying, menace)
and damage multipliers (double strike, deathtouch, trample) score highest, defensive keywords
(vigilance, lifelink, reach) score moderately, and defender scores negative on offense. One table,
shared by all three tiers.

Terminal states short-circuit to ±Infinity, so lethal is always found when it exists at the
searched depth.

### Tiers

| Tier | Search | Behavior |
|---|---|---|
| **Apprentice** | Softmax over one-ply scores, high temperature | Plays reasonably, misses lethal sometimes, makes bad attacks. Beatable by a first-timer. |
| **Magician** | Argmax over one-ply | Finds lethal, trades correctly, holds removal for real threats. |
| **Archmage** | Two-ply alpha-beta, modelling your best response | Bluffs by holding mana open, plays around tricks, sandbags. |

Archmage runs under a **120ms time budget** with iterative deepening. If the budget expires, it
plays the best move found so far. The UI must never stall waiting for the bot.

### Personality

Independent of tier. A speech ribbon surfaces one line on notable events — playing a bomb,
losing a creature, dropping below 5 life, having lethal on board. Lines come from a shuffle bag
so nothing repeats until the bag is empty. A deliberate 400–700ms pause before large plays reads
as thinking and gives the player time to see what is happening.

## 8. Card data pipeline

Runtime makes **zero** network requests. Everything is resolved at build time.

### `tools/build-pool.ts`

1. Reads the hand-authored card list (`data/pool.ts`, ~250 names).
2. Resolves them via Scryfall `/cards/collection` — 75 identifiers per request, **500ms apart**
   (that endpoint's hard limit is 2/second). ~250 cards is 4 requests.
3. Sends a correct `User-Agent: emteegee/<version>` and `Accept: application/json`, as Scryfall
   requires. Honors HTTP 429 with a 30s backoff.
4. Emits `src/data/cards.json`: name, mana cost, CMC, colors, type line, subtypes, power,
   toughness, oracle text, keywords, rarity, artist, set, and local art paths.
5. **Validates every card against the implemented mechanic whitelist and fails the build loudly
   on anything unimplementable.**

Step 5 is the gate that keeps the beginner promise from rotting as the pool grows. A card that
cannot be played correctly must not be shippable.

### `tools/fetch-art.ts`

Downloads `art_crop` and `normal` for every pool card into `public/art/`, downscaled to 420px and
320px wide respectively. Images come from `*.scryfall.io`, which has no rate limit. At ~150
unique cards across six decks this is roughly 10MB committed.

A `--cdn` flag switches the generated JSON to Scryfall CDN URLs instead of local paths, so the
bundle can be slimmed without a code change.

`src/data/cards.json` and `public/art/` are both committed, so the build is reproducible offline
and a contributor never needs API access.

## 9. Interface

### 9.1 Screens

1. **Title** — logo, Play, sound toggle, skin toggle, About.
2. **Deck select** — six deck cards with signature art, theme line, and a difficulty picker.
3. **Table** — the game.
4. **Result** — win/loss, a one-line summary of how it ended, Rematch, Change deck.

Overlays: card zoom, mulligan, targeting, blocker assignment, stack, log, settings.

### 9.2 Table layout

Vertical band structure, top to bottom, at 390px wide:

| Band | Height | Contents |
|---|---|---|
| Opponent rail | 50px | Avatar, name, hand count, library count, life |
| Opponent mana | 30px | Gem row, land count |
| Opponent board | flex | Creature tiles, centered, wrapping |
| Mid strip | 38px | Graveyard, phase rail, exile, stack indicator |
| Your board | flex | Creature tiles, centered, wrapping |
| Your mana | 30px | Gem row, land count |
| Your rail | 50px | Same as opponent, with turn indicator |
| Hand | 118px | Fanned real cards, unaffordable ones dimmed |

Creature tiles are 74px wide with 56px of full-bleed `art_crop`, a power/toughness badge, the
card name, and up to three keyword glyphs. On a board of five or more per side they step down to
56px and wrap to a second row. Tap targets never fall below 44px.

Lands do not appear on the battlefield. They are a row of colored gems — filled for available,
drained and outlined for spent. Long-pressing the row expands the real land cards for manual
tapping.

Tapping any permanent opens the real full card, with the illustrator credited.

### 9.3 Gestures

| Gesture | Result |
|---|---|
| Tap a card in hand | Cast it (auto-taps mana), or show why it can't be cast |
| Tap a creature | Open the full card |
| Tap a creature during declare-attackers | Toggle it into the attack |
| Swipe a creature up | Attack with it immediately |
| Tap your creature, then an attacker | Assign a block |
| Long-press the mana row | Expand lands for manual tapping |
| Tap the primary button | Advance — label always states what will happen |

### 9.4 Pacing

You always tap to advance. The primary button is pinned bottom-right and context-labeled:
`Go to combat`, `Attack with 3`, `Confirm blocks`, `Pass`, `End turn`.

The game skips only those stops where advancing is the sole legal action. Untap and draw still
*animate* — you see them happen — you simply do not tap to acknowledge them. Every tap you make
is a real decision.

### 9.5 Skins

Parchment (warm light), Slate (cool light), Felt (dark). **Felt is the default.** A skin is a set
of ~15 CSS custom properties on the table element; nothing else changes. All three ship and are
switchable from the title screen and in-game settings.

### 9.6 Animation

The animator owns all timing. Engine events map to a timeline:

`DRAW` · `PLAY` · `TAP` · `UNTAP` · `ATTACK` · `BLOCK` · `DAMAGE` · `DIE` · `LIFE_CHANGE`
`COUNTER_ADD` · `TOKEN_CREATE` · `SCRY` · `PHASE` · `TRIGGER` · `WIN`

Constraints:

- No single animation exceeds 600ms. A full combat sequence completes within 2.5s.
- Only `transform` and `opacity` are animated, so everything stays on the compositor.
- Tapping during a sequence fast-forwards it rather than queueing input.
- `prefers-reduced-motion` collapses every animation to a state change with no motion.
- Attacking creatures lunge toward a center lane and settle back — the one motion borrowed from
  the battle-lane layout, used only for the combat moment.

### 9.7 Teaching

No upfront tutorial. The first time a concept appears, one short line surfaces near the relevant
card — "Flying: only creatures with flying or reach can block this." Each hint shows once, ever,
persisted in `localStorage`. Settings offers "show hints again".

Hints never block play and never require dismissal to continue.

### 9.8 Accessibility

Every card tile is a real button with a descriptive label ("Serra Angel, 4/4, flying, vigilance,
untapped"). Visible focus states throughout. Minimum 44px touch targets. Reduced motion honored.
Color is never the sole carrier of meaning — tapped state uses rotation and desaturation together,
and mana gems use fill *and* outline.

## 10. Audio

Kenney's CC0 packs (Interface Sounds, Impact Sounds, UI Audio, RPG Audio, Casino Audio) provide
the base samples. CC0 requires no attribution, though the README will credit them anyway.

A pooled Web Audio wrapper avoids allocation during play. Every game event has a sound; volume
and mute persist. Sounds are preloaded during deck select so the first card play is never silent.

Mapping: card draw and card play use the card-handling samples; tapping is a soft blip; combat
damage is a layered impact; creature death is a lower impact with a pitch drop; life loss is a
distinct tone from creature damage so the two are never confused by ear.

## 11. The six decks

60 cards each, ~24 lands, one signature bomb, and exactly one idea to teach.

| Deck | Colors | Signature | Teaches |
|---|---|---|---|
| **Valor** | Mono-white | Serra Angel | Go wide, then one pump wins the race |
| **Ember** | Mono-red | Shivan Dragon | Speed, haste, and reach to the face |
| **Thicket** | Mono-green | Craw Wurm | Ramp into something enormous |
| **Skies** | Blue/white | Air Elemental | Evasion — flying simply wins |
| **Nightfall** | Black/red | Sengir Vampire | Removal and life swing |
| **Bloom** | Green/white | Ajani's Pridemate | +1/+1 counters compound |

Two deliberate choices:

**No mono-blue deck.** Blue's beginner-facing cards are counterspells and bounce, which teach
"your turn did nothing". Blue appears in Skies, where flying carries the deck.

**Ember is capped.** A mono-red deck that teaches reach is one card away from teaching "you lose
on turn four". No more than six burn spells, and no burn larger than a Lightning Bolt effect.

Both players draw from the same six decks, so mirrors are possible and legal.

## 12. Testing

Engine work is test-driven. Tests are pure — no DOM, no timers, no fake clocks.

- **Keywords.** One test per keyword, asserting the specific interaction that makes it matter:
  deathtouch kills a 10/10; trample assigns lethal then spills; first strike resolves in its own
  damage step; menace requires two blockers; lifelink triggers on damage, not on cast; vigilance
  does not tap; defender cannot attack; ward taxes the targeter; flash allows a creature at
  instant speed.
- **Combat.** A table-driven matrix of attacker/blocker configurations with expected survivors,
  damage dealt, and life totals.
- **Stack.** Resolution order is LIFO; the cap rejects a fourth object; no trigger enqueues a
  trigger.
- **State-based actions.** Applied after every resolution, not only at phase boundaries.
- **Bot.** Property test: across 10,000 randomly generated states, no tier ever emits an action
  that `legalActions` did not offer. Archmage always respects its time budget.
- **Pool.** Every card in every deck passes the whitelist validator, and every deck is exactly
  60 cards with a legal mana base.
- **UI.** Smoke tests only — a full game played through the public intent API, asserting the
  match reaches a terminal state.

## 13. Error handling

- **Build time.** An unimplementable card fails the build with the card name and the offending
  oracle text. Silence is not an option here.
- **Engine.** Illegal actions throw. Reaching one is a bug, not a user error, and it should be
  loud in development.
- **UI boundary.** The intent handler catches, logs the action log, and shows a recoverable
  "something went wrong" panel with a Restart. Never a white screen.
- **Images.** `onerror` falls back to a generated placeholder tile carrying the card's color
  identity and name, so a missing asset leaves a readable card rather than a hole.
- **Audio.** Playback failures are swallowed. Sound is never load-bearing.

## 14. File structure

```
emteegee/
  index.html
  package.json
  vite.config.ts
  src/
    main.ts
    engine/    state.ts  cards.ts  actions.ts  effects.ts  combat.ts  rules.ts  events.ts
    bot/       magician.ts  evaluate.ts  personality.ts
    ui/        table.ts  card.ts  hand.ts  rail.ts  mana.ts  stack.ts  animator.ts  hints.ts
               overlay.ts  screens.ts
    audio/     kit.ts  sounds.ts
    decks/     valor.ts  ember.ts  thicket.ts  skies.ts  nightfall.ts  bloom.ts
    data/      pool.ts  cards.json        (cards.json generated, committed)
    skins/     parchment.css  slate.css  felt.css
  public/art/                             (generated, committed)
  tools/       build-pool.ts  fetch-art.ts  validate.ts
  tests/
  docs/
```

## 15. Build order

Each milestone is independently verifiable. Engine milestones land with their tests before any
UI work begins, so the UI is built against an engine that is already known correct.

| # | Milestone | Done when |
|---|---|---|
| 1 | Engine core: state, zones, turn structure, priority, stack | A game can be played to completion through the action API with no cards but lands |
| 2 | Effect vocabulary and keywords | Every keyword test passes |
| 3 | Combat | The combat matrix passes |
| 4 | Card pipeline and validator | `cards.json` builds and rejects an unimplementable card |
| 5 | Six decks | Each deck is 60 cards, validates, and plays to completion bot-vs-bot |
| 6 | Table UI and skins | The table renders a live game in all three skins at 390px |
| 7 | Animator and audio | A full combat sequence animates within budget with sound |
| 8 | Bot tiers | Property tests pass; Archmage respects its time budget |
| 9 | Screens, hints, result flow | A player can go title → deck → match → rematch without a dead end |
| 10 | Performance and accessibility pass | 60fps on a mid-range phone; every control labeled and reachable |

## 16. Licensing and attribution

- **Code**: open source, MIT.
- **Card names, rules text, and game rules**: not copyrightable as such; reproduced for
  interoperability.
- **Card art**: bundled in the repository. The project owner has confirmed the rights to
  redistribute. Every card credits its illustrator on the zoom view, and `tools/fetch-art.ts`
  keeps the bundle reproducible — `--cdn` switches to Scryfall-hosted images without a code
  change if the distribution posture ever needs to change.
- **Audio**: Kenney, CC0. Credited in the README as a courtesy.
- **Scryfall**: credited in the README. The build pipeline honors their documented rate limits
  (2/sec on `/cards/collection`, 100ms elsewhere) and sends the required headers.
