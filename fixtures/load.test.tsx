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
