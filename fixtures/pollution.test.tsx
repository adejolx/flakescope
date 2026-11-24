// FLAKE KIND: order dependence with ONE hidden polluter among many tests.
// 'victim' passes in file order (it runs first). It fails whenever
// 'polluter: logs in' happens to run before it. The other tests are innocent.
import { test, expect } from 'vitest';

let session: string | null = null;
let theme = 'light';
let counter = 0;

test('pollution: victim expects a logged-out session', () => {
  expect(session).toBeNull();
});

test('pollution: innocent a changes the theme', () => {
  theme = 'dark';
  expect(theme).toBe('dark');
});

test('pollution: innocent b increments a counter', () => {
  counter++;
  expect(counter).toBeGreaterThan(0);
});

test('pollution: innocent c reads the theme', () => {
  expect(['light', 'dark']).toContain(theme);
});

test('pollution: polluter logs in', () => {
  session = 'alice';
  expect(session).toBe('alice');
});

test('pollution: innocent d resets the counter', () => {
  counter = 0;
  expect(counter).toBe(0);
});

test('pollution: innocent e checks arithmetic', () => {
  expect(1 + 1).toBe(2);
});

test('pollution: innocent f checks strings', () => {
  expect('a' + 'b').toBe('ab');
});
