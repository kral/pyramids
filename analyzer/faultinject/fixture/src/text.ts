export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
export function initials(name: string): string {
  const parts = name.split(' ').filter((p) => p.length > 0);
  let out = '';
  for (const p of parts) {
    out += p[0].toUpperCase();
  }
  return out || '?';
}
export function plural(n: number, one: string, few: string, many: string) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}
export function label(user?: { name?: string; nick?: string }) {
  return user?.nick ?? user?.name ?? 'anonym';
}
