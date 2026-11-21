// @vitest-environment jsdom
import { test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Counter } from '../src/Counter';
afterEach(() => cleanup());
test('renders label', () => { render(<Counter label="Add" />); expect(screen.getByRole('button').textContent).toBe('Add'); });
test('starts at value', () => { render(<Counter label="x" start={5} />); expect(screen.getByRole('status').textContent).toBe('many'); });
test('increments', () => {
  render(<Counter label="x" />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByTestId('n').textContent).toBe('1');
  expect(screen.queryByRole('status')).toBeNull();
});
