# emteegee

The easiest way to play the best card game.

A single-player Magic: The Gathering game that runs in a mobile browser. Pick one of six
themed decks and play a game against The Magician. No account, no collection, no
deckbuilder — the product is the match.

Built for phones first: real touch gestures, art-forward layout, sound on every
meaningful event, and a board that stays legible when it fills up.

## What makes it beginner-friendly

Not a watered-down engine. The rules underneath are real Magic — a stack, priority,
state-based actions, correct combat damage assignment. What makes it approachable is
the card pool and the pacing:

**The pool is gated.** Every card is checked at build time against the mechanics the
engine actually implements. A card that cannot be played correctly fails the build
rather than shipping and misbehaving. That gate rejects planeswalkers, graveyard
recursion, protection, regeneration, X costs, fight, gain-control, dynamic power — and
it means a card in this game is a promise, not a hope.

**The pacing skips nothing that matters.** You always tap to advance, and the button
always says exactly what the tap will do (`Go to combat`, `Attack with 3`,
`Confirm blocks`, `End turn`). The game auto-passes only through steps where advancing
is the *sole* legal action — you still see untap and draw happen, you just do not
acknowledge them. Every tap you make is a real decision.

**It teaches at the moment of need.** No tutorial. The first time flying shows up, one
line explains flying, and then never again.

## Play

```bash
npm install
npm run dev
```

That is the whole setup. The card data, the art and the sound kit are all committed, so
a fresh clone plays immediately and never touches the network — please do not re-run the
Scryfall pipeline just to get started.

Open the printed URL on your phone (same wifi), or resize a desktop browser to phone
width.

The asset pipeline is only for changing what is in the game:

```bash
npm run pool     # re-resolve the card pool from Scryfall and re-validate it
npm run art      # download and downscale any art the pool is missing
npm run sfx      # reassemble the sound kit from the Kenney packs
```

## Deploying

The whole thing is static and self-contained: card data, art and sound are committed,
so a build never touches Scryfall and a player never waits on anything but the CDN.

Point Netlify at the repository and it will pick up `netlify.toml` — build command,
publish directory, Node version, cache headers and a strict Content-Security-Policy are
all configured. Nothing else to set up, and no environment variables.

```bash
npm test && npm run build   # what Netlify runs; dist/ is the deployable artifact
```

The deploy runs the test suite before building, and `npm run build` typechecks before
bundling, so neither a rules regression nor a type error can ship.

Two decisions worth knowing if you change the config:

- **There is no SPA catch-all redirect.** The game swaps screens in JavaScript without
  touching the URL, so there are no client-side routes to rescue — and a catch-all
  would turn a missing art file into a 200 serving `index.html`, which is how a broken
  bundle ships unnoticed.
- **The CSP is `'self'` and means it.** No inline scripts, no external origins. The one
  concession is `style-src 'unsafe-inline'`, because a few overlay panels set style
  attributes directly. It was verified against the built bundle rather than assumed.

## How it is built

The engine is a pure, event-sourced function:

```ts
reduce(state, action) -> { state, events }
```

It knows nothing about the DOM, timers, or animation. That single constraint buys four
things: engine tests run in milliseconds with no fake clocks, the bot searches by
calling the same reducer it plays through (so it structurally cannot cheat), animation
can never desync from state because it is strictly downstream, and a game is just its
action log.

`legalActions(state)` is the only source of legality. The UI asks it what to make
tappable, the bot asks it what it may consider, and the tests assert against it.
`isLegal` is implemented as a membership check against it, so the two can never
disagree.

```
src/
  engine/    types, state, actions, effects, combat, rules   pure, no DOM
  bot/       three tiers over one shared evaluator
  ui/        table, session, animator, gestures, screens, hints
  audio/     pooled Web Audio over a CC0 sample kit
  decks/     six 60-card decks
  data/      the card pool, hand-authored behaviors, generated cards.json
tools/       Scryfall pipeline, whitelist validator, art and sound fetchers
docs/        the design spec, the implementation plan, layout prototypes
```

Cards are **data**, not code. A card's behavior is a list of descriptors drawn from a
closed vocabulary (`damage`, `destroy`, `pump`, `createToken`, `scry`, …). Adding a card
never means writing new engine code; adding a *mechanic* is a deliberate change to that
vocabulary, recorded in the spec.

## Tests

```bash
npm test
```

Every keyword has a test for the interaction that makes it matter — deathtouch kills a
10/10, trample assigns lethal then spills, first strike resolves in its own damage step
so a dead blocker deals nothing back, menace is validated across the whole block
assignment rather than per blocker, lifelink triggers on damage rather than on cast.
The bot has a property test: across thousands of generated positions it never emits an
action `legalActions` did not offer.

## The six decks

| Deck | Colors | Teaches |
|---|---|---|
| **Valor** | Mono-white | Going wide, then one pump wins the race |
| **Ember** | Mono-red | Speed, haste, and reach to the face |
| **Thicket** | Mono-green | Ramp into something enormous |
| **Skies** | Blue/white | Evasion — flying simply wins |
| **Nightfall** | Black/red | Removal and life swing |
| **Bloom** | Green/white | +1/+1 counters compound |

There is deliberately no mono-blue deck. Blue's beginner-facing cards are counterspells
and bounce, which teach "your turn did nothing" — the worst possible first experience.
Blue appears in Skies, where flying carries it.

## Credits and licensing

- **Code** — MIT.
- **Card data and images** — [Scryfall](https://scryfall.com). The build pipeline honors
  their documented rate limits and sends the required headers; the game itself makes no
  network requests at all.
- **Sounds** — [Kenney](https://kenney.nl), CC0. No attribution required; credited here
  anyway.
- **Card art** — copyright Wizards of the Coast and the individual illustrators. Every
  card credits its artist on the zoom view. `tools/fetch-art.ts --cdn` switches the
  build from a bundled art folder to Scryfall-hosted images without a code change.

Magic: The Gathering is a trademark of Wizards of the Coast. This is an unofficial
open-source demo for learning the game, not affiliated with or endorsed by Wizards.

## Design documents

- [Design spec](docs/superpowers/specs/2026-08-10-emteegee-design.md) — the decisions and
  why, including the vocabulary revision that "any target" forced
- [Implementation plan](docs/superpowers/plans/2026-08-10-emteegee.md)
- [Layout prototypes](docs/prototypes/) — three table layouts and three skins, live at
  390px, which is how the current layout got chosen
