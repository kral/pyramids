import type { ReactNode } from 'react';

interface ButtonProps {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

export function Button({ children, disabled, onClick }: ButtonProps) {
  const handle = () => {
    onClick?.();
  };
  return (
    <button type="button" aria-disabled={disabled} onClick={handle}>
      {children}
    </button>
  );
}
