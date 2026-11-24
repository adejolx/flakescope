// FLAKE KIND: timing. Component loads after a random delay; the test
// asserts after a fixed wait. Fails when the delay exceeds the wait.
import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';

function Loader() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 20 + Math.random() * 60);
    return () => clearTimeout(t);
  }, []);
  return <p>{ready ? 'ready' : 'loading'}</p>;
}

test('timing: shows ready after a fixed sleep', async () => {
  render(<Loader />);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText('ready')).toBeTruthy();
});
