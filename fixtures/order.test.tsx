import { test, expect } from 'vitest';

let cache: string | null = null;

test('order: reader assumes empty cache', () => {
  expect(cache).toBeNull();
});

test('order: writer populates cache', () => {
  cache = 'dirty';
  expect(cache).toBe('dirty');
});
