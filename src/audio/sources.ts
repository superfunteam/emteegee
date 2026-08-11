/**
 * Which Kenney file backs each sound in the game.
 *
 * The key is what the sound *means* here; the value is where it came from. Keeping the
 * mapping in one table means the call sites read `play('damage-player')` rather than
 * `play('impactBell_heavy_002')`, and swapping a sound is a one-line change.
 *
 * All five source packs are CC0 (public domain, no attribution required). The README
 * credits Kenney anyway.
 *
 * Two deliberate choices, both from spec section 10:
 *   - Damage to a player and damage to a creature use different instruments — a bell
 *     versus metal — so the two are never confused by ear during combat.
 *   - Anything that fires repeatedly (draw, tap, place) has numbered variants, so a
 *     turn where you play four lands does not sound like a stuck key.
 */

export interface SfxSource {
  pack: 'interface-sounds' | 'impact-sounds' | 'ui-audio' | 'rpg-audio' | 'casino-audio';
  file: string;
}

export const SFX_SOURCES: Record<string, SfxSource> = {
  // --- Card handling -------------------------------------------------------
  'draw-1': { pack: 'casino-audio', file: 'card-slide-1.ogg' },
  'draw-2': { pack: 'casino-audio', file: 'card-slide-3.ogg' },
  'draw-3': { pack: 'casino-audio', file: 'card-slide-5.ogg' },
  'play-1': { pack: 'casino-audio', file: 'card-place-1.ogg' },
  'play-2': { pack: 'casino-audio', file: 'card-place-2.ogg' },
  'play-3': { pack: 'casino-audio', file: 'card-place-4.ogg' },
  'shuffle': { pack: 'casino-audio', file: 'card-shuffle.ogg' },
  'fan': { pack: 'casino-audio', file: 'card-fan-1.ogg' },
  'mulligan': { pack: 'casino-audio', file: 'card-shove-2.ogg' },

  // --- Spells --------------------------------------------------------------
  'cast': { pack: 'interface-sounds', file: 'pluck_001.ogg' },
  'cast-instant': { pack: 'interface-sounds', file: 'pluck_002.ogg' },
  'resolve': { pack: 'interface-sounds', file: 'confirmation_002.ogg' },
  'countered': { pack: 'interface-sounds', file: 'glitch_002.ogg' },

  // --- Permanents ----------------------------------------------------------
  'tap': { pack: 'ui-audio', file: 'click3.ogg' },
  'untap': { pack: 'interface-sounds', file: 'switch_003.ogg' },
  'token': { pack: 'casino-audio', file: 'chip-lay-1.ogg' },
  'counter-add': { pack: 'interface-sounds', file: 'tick_002.ogg' },

  // --- Combat --------------------------------------------------------------
  'attack': { pack: 'rpg-audio', file: 'knifeSlice.ogg' },
  'attack-alt': { pack: 'rpg-audio', file: 'knifeSlice2.ogg' },
  'block': { pack: 'impact-sounds', file: 'impactMetal_light_000.ogg' },
  'damage-creature': { pack: 'impact-sounds', file: 'impactMetal_medium_000.ogg' },
  'damage-creature-alt': { pack: 'impact-sounds', file: 'impactMetal_medium_003.ogg' },
  /** Deliberately a bell, not metal — player damage must be audibly distinct. */
  'damage-player': { pack: 'impact-sounds', file: 'impactBell_heavy_001.ogg' },
  'die': { pack: 'impact-sounds', file: 'impactSoft_heavy_003.ogg' },
  'life-gain': { pack: 'interface-sounds', file: 'bong_001.ogg' },

  // --- Interface -----------------------------------------------------------
  'button': { pack: 'ui-audio', file: 'click1.ogg' },
  'blip': { pack: 'interface-sounds', file: 'click_002.ogg' },
  'select': { pack: 'interface-sounds', file: 'select_002.ogg' },
  'zoom-open': { pack: 'interface-sounds', file: 'open_001.ogg' },
  'zoom-close': { pack: 'interface-sounds', file: 'close_001.ogg' },
  'illegal': { pack: 'interface-sounds', file: 'error_002.ogg' },
  'phase': { pack: 'ui-audio', file: 'rollover2.ogg' },
  'scry': { pack: 'rpg-audio', file: 'bookFlip2.ogg' },

  // --- Match ---------------------------------------------------------------
  'win': { pack: 'interface-sounds', file: 'confirmation_004.ogg' },
  'lose': { pack: 'interface-sounds', file: 'question_004.ogg' },
  'turn-start': { pack: 'interface-sounds', file: 'bong_001.ogg' },
};

/** Sounds picked at random from a set, so repeats do not sound mechanical. */
export const SFX_VARIANTS: Record<string, readonly string[]> = {
  draw: ['draw-1', 'draw-2', 'draw-3'],
  play: ['play-1', 'play-2', 'play-3'],
  attack: ['attack', 'attack-alt'],
  'damage-creature': ['damage-creature', 'damage-creature-alt'],
};
