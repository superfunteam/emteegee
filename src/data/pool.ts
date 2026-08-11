/**
 * The card pool: every card this game is allowed to contain.
 *
 * Hand-picked all-time classics, then filtered by tools/validate.ts against the
 * implemented mechanic whitelist. A name here is a promise that the engine can play
 * the card correctly, and `npm run pool` fails the build if that stops being true.
 *
 * 131 cards. Add by name; the pipeline resolves everything else from Scryfall.
 */

export const POOL: readonly string[] = [

  // Lands
  "Forest",
  "Island",
  "Mountain",
  "Plains",
  "Swamp",

  // White
  "Ajani's Pridemate",
  "Alaborn Trooper",
  "Angel of Mercy",
  "Angelic Blessing",
  "Benalish Knight",
  "Benalish Marshal",
  "Captain's Call",
  "Elite Vanguard",
  "Field Marshal",
  "Gideon's Lawkeeper",
  "Glorious Anthem",
  "Healer's Hawk",
  "Holy Strength",
  "Kinsbaile Skirmisher",
  "Leonin Skyhunter",
  "Marked by Honor",
  "Master Decoy",
  "Raise the Alarm",
  "Sacred Nectar",
  "Savannah Lions",
  "Serra Angel",
  "Serra's Embrace",
  "Soul Warden",
  "Standing Troops",
  "Sunlance",
  "Suntail Hawk",
  "Veteran Swordsmith",
  "Wall of Omens",
  "Wrath of God",
  "Youthful Knight",

  // Blue
  "Air Elemental",
  "Azure Drake",
  "Cloudkin Seer",
  "Coral Merfolk",
  "Counterspell",
  "Divination",
  "Essence Scatter",
  "Horned Turtle",
  "Man-o'-War",
  "Merfolk Looter",
  "Mist Raven",
  "Negate",
  "Opt",
  "Phantom Monster",
  "Preordain",
  "Serendib Efreet",
  "Snapping Drake",
  "Storm Crow",
  "Unsummon",
  "Wall of Air",
  "Wind Drake",
  "Zephyr Falcon",

  // Black
  "Barony Vampire",
  "Bloodhunter Bat",
  "Bloodrite Invoker",
  "Cackling Fiend",
  "Child of Night",
  "Dark Banishing",
  "Doom Blade",
  "Mind Rot",
  "Murder",
  "Nightwing Shade",
  "Rotting Fensnake",
  "Terror",
  "Typhoid Rats",
  "Untamed Hunger",
  "Vampire Interloper",
  "Vampire Nighthawk",
  "Walking Corpse",
  "Zombie Goliath",

  // Red
  "Bogardan Firefiend",
  "Canyon Minotaur",
  "Dragon Hatchling",
  "Ember Hauler",
  "Fire Elemental",
  "Furnace Whelp",
  "Goblin Balloon Brigade",
  "Goblin Chieftain",
  "Goblin Piker",
  "Goblin Roughrider",
  "Goblin Sky Raider",
  "Hill Giant",
  "Incinerate",
  "Krenko's Command",
  "Lava Axe",
  "Lightning Bolt",
  "Mogg Fanatic",
  "Mons's Goblin Raiders",
  "Onakke Ogre",
  "Prodigal Pyromancer",
  "Raging Goblin",
  "Searing Spear",
  "Shivan Dragon",
  "Shock",
  "Torch Fiend",
  "Trumpet Blast",
  "Viashino Pyromancer",
  "Volcanic Hammer",

  // Green
  "Aggressive Urge",
  "Ambush Viper",
  "Canopy Spider",
  "Colossal Dreadmaw",
  "Craw Wurm",
  "Elvish Mystic",
  "Elvish Warrior",
  "Garruk's Companion",
  "Giant Growth",
  "Giant Spider",
  "Grizzled Outrider",
  "Grizzly Bears",
  "Llanowar Elves",
  "Overrun",
  "Pelakka Wurm",
  "Rumbling Baloth",
  "Runeclaw Bear",
  "Silverback Ape",
  "Spined Wurm",
  "Titanic Growth",
  "Trained Armodon",
  "Vastwood Gorger",
  "Vine Trellis",
  "Wall of Wood",
  "Wildsize",
  "Yavimaya Wurm",

  // Multicolor
  "Sky Spirit",
  "Skyknight Legionnaire",
];

/** Stable identifier derived from a card name: "Serra Angel" -> "serra-angel". */
export function toOracleId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const POOL_IDS: readonly string[] = POOL.map(toOracleId);
