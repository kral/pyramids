import { describe, test, expect } from 'vitest';
import { slug, initials, plural, label } from '../src/index';
describe('slug', () => {
  test('simple', () => { expect(slug('  Hello World ')).toBe('hello-world'); });
  test('symbols', () => { expect(slug('a&b--c!')).toBe('a-b-c'); });
});
describe('initials', () => {
  test('two words', () => { expect(initials('jan novak')).toBe('JN'); });
  test('empty', () => { expect(initials('   ')).toBe('?'); });
});
describe('plural', () => {
  test('one', () => { expect(plural(1, 'kus', 'kusy', 'kusů')).toBe('kus'); });
  test('few', () => { expect(plural(3, 'kus', 'kusy', 'kusů')).toBe('kusy'); });
  test('four', () => { expect(plural(4, 'kus', 'kusy', 'kusů')).toBe('kusy'); });
  test('many', () => { expect(plural(5, 'kus', 'kusy', 'kusů')).toBe('kusů'); });
});
describe('label', () => {
  test('nick', () => { expect(label({ name: 'A', nick: 'B' })).toBe('B'); });
  test('name', () => { expect(label({ name: 'A' })).toBe('A'); });
  test('none', () => { expect(label()).toBe('anonym'); });
});
