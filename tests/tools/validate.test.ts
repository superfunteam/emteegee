import { describe, it, expect } from 'vitest';
import { validateCard } from '../../tools/validate';

const card = (over: Partial<Parameters<typeof validateCard>[0]>) => ({
  name: 'Test Card',
  type_line: 'Creature — Human',
  oracle_text: '',
  keywords: [] as string[],
  ...over,
});

describe('validateCard accepts what the engine can honor', () => {
  it('a vanilla creature', () => {
    expect(validateCard(card({ name: 'Grizzly Bears', type_line: 'Creature — Bear' })).ok).toBe(true);
  });

  it('implemented keywords', () => {
    const r = validateCard(card({
      name: 'Serra Angel',
      type_line: 'Creature — Angel',
      oracle_text: 'Flying, vigilance',
      keywords: ['Flying', 'Vigilance'],
    }));
    expect(r.ok).toBe(true);
  });

  it('a burn spell', () => {
    const r = validateCard(card({
      name: 'Lightning Bolt',
      type_line: 'Instant',
      oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    }));
    expect(r.ok).toBe(true);
  });

  it('a basic land', () => {
    expect(validateCard(card({ name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '({T}: Add {G}.)' })).ok).toBe(true);
  });

  it('an aura', () => {
    const r = validateCard(card({
      name: 'Holy Strength',
      type_line: 'Enchantment — Aura',
      oracle_text: 'Enchant creature\nEnchanted creature gets +1/+2.',
    }));
    expect(r.ok).toBe(true);
  });
});

describe('validateCard rejects what it cannot', () => {
  it('a planeswalker', () => {
    const r = validateCard(card({ name: 'Jace', type_line: 'Legendary Planeswalker — Jace', oracle_text: '+1: Draw a card.' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/planeswalker/i);
  });

  it('an unimplemented keyword', () => {
    const r = validateCard(card({ name: 'Deep Analysis', type_line: 'Sorcery', keywords: ['Flashback'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/flashback/i);
  });

  it('graveyard recursion', () => {
    const r = validateCard(card({
      name: 'Raise Dead',
      type_line: 'Sorcery',
      oracle_text: 'Return target creature card from your graveyard to your hand.',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/graveyard/i);
  });

  it('a tutor', () => {
    const r = validateCard(card({
      name: 'Demonic Tutor',
      type_line: 'Sorcery',
      oracle_text: 'Search your library for a card, put it into your hand, then shuffle.',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tutor/i);
  });

  it('protection', () => {
    const r = validateCard(card({ name: 'X', oracle_text: 'Protection from red' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protection/i);
  });

  it('regeneration', () => {
    const r = validateCard(card({ name: 'X', oracle_text: '{G}: Regenerate this creature.' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/regeneration/i);
  });

  it('an alternate win condition', () => {
    const r = validateCard(card({ name: 'X', type_line: 'Enchantment', oracle_text: 'At the beginning of your upkeep, you win the game.' }));
    expect(r.ok).toBe(false);
  });

  it('a transforming card', () => {
    const r = validateCard(card({ name: 'X', layout: 'transform', card_faces: [{}, {}] }));
    expect(r.ok).toBe(false);
  });

  it('extra turns', () => {
    const r = validateCard(card({ name: 'Time Walk', type_line: 'Sorcery', oracle_text: 'Take an extra turn after this one.' }));
    expect(r.ok).toBe(false);
  });

  it('a trigger that triggers off another trigger', () => {
    const r = validateCard(card({
      name: 'X',
      oracle_text: 'Whenever another ability triggers, draw a card.',
    }));
    expect(r.ok).toBe(false);
  });
});

describe('inert text does not cause false rejections', () => {
  it('accepts Wrath of God, whose "can\'t be regenerated" rider is a no-op here', () => {
    const r = validateCard(card({
      name: 'Wrath of God',
      type_line: 'Sorcery',
      oracle_text: "Destroy all creatures. They can't be regenerated.",
    }));
    expect(r.ok).toBe(true);
  });

  it('accepts Terror, same rider', () => {
    const r = validateCard(card({
      name: 'Terror',
      type_line: 'Instant',
      oracle_text: "Destroy target nonartifact, nonblack creature. It can't be regenerated.",
    }));
    expect(r.ok).toBe(true);
  });

  it('ignores parenthetical reminder text', () => {
    const r = validateCard(card({
      name: 'Deathtouch Creature',
      type_line: 'Creature — Snake',
      keywords: ['Deathtouch'],
      oracle_text: 'Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)',
    }));
    expect(r.ok).toBe(true);
  });

  it('still rejects a real regenerate ability', () => {
    const r = validateCard(card({ name: 'Drudge Skeletons', oracle_text: '{B}: Regenerate Drudge Skeletons.' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/regeneration/i);
  });

  it('still rejects graveyard text that sits outside reminder parentheses', () => {
    const r = validateCard(card({
      name: 'Gravedigger',
      type_line: 'Creature — Zombie',
      oracle_text: 'When Gravedigger enters, you may return target creature card from your graveyard to your hand.',
    }));
    expect(r.ok).toBe(false);
  });
});

describe('rejects mechanics that read as ordinary Magic but have no vocabulary member', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['Prey Upon', 'Target creature you control fights target creature you don\'t control.', /fight/i],
    ['Act of Treason', 'Gain control of target creature until end of turn.', /control/i],
    ['Fireball', 'Fireball deals X damage to any target.', /X cost/i],
    ['Nightmare', "Nightmare's power and toughness are each equal to the number of Swamps you control.", /dynamic/i],
    ['Juggernaut', "Juggernaut attacks each combat if able. Juggernaut can't be blocked by Walls.", /attack requirement|blocking restriction/i],
    ['Kird Ape', 'Kird Ape gets +1/+2 for each Forest you control.', /per-object/i],
    ['Cryptic Command', 'Choose two — Counter target spell; or return target permanent to its owner\'s hand.', /modal/i],
  ];

  it.each(cases)('rejects %s', (name, oracle_text, why) => {
    const r = validateCard(card({ name, oracle_text }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(why);
  });
});

describe('the gate explains itself', () => {
  it('every rejection carries a human-readable reason naming the card', () => {
    const r = validateCard(card({ name: 'Snapcaster Mage', oracle_text: 'Target instant card in your graveyard gains flashback.' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Snapcaster Mage');
    expect(r.reason!.length).toBeGreaterThan(20);
  });
});
