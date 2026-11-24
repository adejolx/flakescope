import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';

test('stable: renders a heading', () => {
  render(<h1>Hello</h1>);
  expect(screen.getByRole('heading').textContent).toBe('Hello');
});
