import type { User } from '../api/client';

interface Props {
  users?: User[];
  onSelect: (id: string) => void;
}

/** Seznam uživatelů – vykreslí jméno a e-mail. */
export function UserList({ users, onSelect }: Props) {
  return (
    <ul className="user-list">
      {users.map((u) => (
        <li key={u.id} onClick={() => onSelect(u.id)}>
          {u.name} <small>{u.email}</small>
        </li>
      ))}
    </ul>
  );
}
