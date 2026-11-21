import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UserList } from './UserList';

describe('UserList', () => {
  it('renders users', () => {
    render(<UserList users={[{ id: '1', name: 'Jana', email: 'jana@example.cz' }]} onSelect={vi.fn()} />);
    expect(screen.getByText('Jana')).toBeInTheDocument();
  });

  it('renders empty state while loading', () => {
    render(<UserList onSelect={vi.fn()} />);
    expect(screen.getByRole('list')).toBeEmptyDOMElement();
  });
});
