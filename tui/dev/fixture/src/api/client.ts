export interface User { id: string; name: string; email: string }

const BASE = '/api';

export async function fetchUsers(signal?: AbortSignal): Promise<User[]> {
  const res = await fetch(`${BASE}/users`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= attempts) throw e; }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
}
