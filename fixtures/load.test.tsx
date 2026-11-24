// FLAKE KIND: CPU-load sensitivity. Rendering 3000 rows takes ~120 ms on an
// idle machine and 3x that when the CPU is busy. The budget is a hard-coded
// 200 ms, so the test passes alone and fails when the machine is busy
// (for example in CI, with other test files running at the same time).
import { render } from '@testing-library/react';
import { test, expect } from 'vitest';

function BigList() {
  return (
    <ul>
      {Array.from({ length: 3000 }, (_, i) => (
        <li key={i}>{`item ${i}`}</li>
      ))}
    </ul>
  );
}

test('load: renders a big list within its time budget', () => {
  const start = performance.now();
  render(<BigList />);
  expect(performance.now() - start).toBeLessThan(200);
});
