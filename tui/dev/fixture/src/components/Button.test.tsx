import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('calls onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Uložit</Button>);
    fireEvent.click(screen.getByText('Uložit'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Uložit</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(0);
  });
});
