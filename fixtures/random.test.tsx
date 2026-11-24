// FLAKE KIND: randomness/time. Passes ~90% of the time.
import { test, expect } from 'vitest';

test('random: unseeded Math.random under a threshold', () => {
  expect(Math.random()).toBeLessThan(0.9);
});
