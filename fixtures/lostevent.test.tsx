// FLAKE KIND: a wait that times out because the update never arrives.
// Modeled on a real flaky test found in the intercode project: passing runs
// finish in a few ms, failing runs sit until waitFor gives up.
// About 30% of the time the update is skipped. The skip depends on the clock
// (not Math.random), so the Math.random probe can't explain it.
import { useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { test, expect } from 'vitest';

function Loader() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const skipped = Math.floor(performance.now()) % 10 < 3;
    if (skipped) return;
    const t = setTimeout(() => setLoaded(true), 20);
    return () => clearTimeout(t);
  }, []);
  return <p>{loaded ? 'loaded' : 'waiting'}</p>;
}

test('lostevent: waits for an update that sometimes never comes', async () => {
  render(<Loader />);
  await waitFor(() => expect(screen.getByText('loaded')).toBeTruthy(), { timeout: 300 });
});
