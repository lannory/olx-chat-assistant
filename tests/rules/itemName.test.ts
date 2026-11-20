import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectItem, detectItemName, itemsSchema } from '../../src/rules/itemName.js';
import { templatesSchema } from '../../src/rules/templates.js';

const { items } = templatesSchema.parse(JSON.parse(readFileSync('config/templates.example.json', 'utf8')));

describe('detectItemName (rules from templates.example.json)', () => {
  it.each([
    ['Ноутбук Lenovo ThinkPad T480', 'ноутбук'],
    ['Ноутбук Dell + зарядка', 'ноутбук'],
    ['Зарядка для ноутбука Lenovo', 'зарядка'],
    ['Зарядки Lenovo 65W, 2 шт', 'зарядки'],
    ['Сумка для ноутбука 15.6"', 'сумка'],
    ['Мишка Logitech', 'мишка'],
    ['Lenovo ThinkPad T14', 'ноутбук'],
    ['Велосипед дитячий', 'товар'],
  ])('%s → %s', (title, expected) => {
    expect(detectItemName(title, items)).toBe(expected);
  });

  it('gives the category of the matched rule; unknown items have none', () => {
    expect(detectItem('Зарядка для ноутбука', items)).toEqual({ name: 'зарядка', category: 'accessory', unknown: false });
    expect(detectItem('Asus VivoBook', items)).toEqual({ name: 'ноутбук', category: 'main', unknown: false });
    expect(detectItem('Велосипед', items)).toEqual({ name: 'товар', category: null, unknown: true });
  });

  it('falls back to the default name when the title is missing or there are no rules', () => {
    expect(detectItemName(null, items)).toBe('товар');
    expect(detectItemName('Ноутбук', itemsSchema.parse(undefined))).toBe('товар');
  });
});
