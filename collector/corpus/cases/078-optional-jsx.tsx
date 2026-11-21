type U = { name?: string; tags?: string[]; profile?: { avatar?: string } } | null;
export function Card({ user, onPick }: { user: U; onPick?: (s: string) => string }) {
  return (
    <div>
      <h2>{user?.name ?? 'anonymous'}</h2>
      {user?.tags?.length ? <ul>{user.tags.map((t) => <li key={t}>{onPick?.(t) ?? t}</li>)}</ul> : <p>no tags</p>}
      {user?.profile?.avatar && <img src={user.profile.avatar} alt="" />}
      <span>{String(user?.tags?.[5] ?? '-')}</span>
    </div>
  );
}
export function scenario(t: any) {
  return [
    t.renderToStaticMarkup(<Card user={null} />),
    t.renderToStaticMarkup(<Card user={{ name: 'N', tags: ['a', 'b'], profile: { avatar: 'x.png' } }} onPick={(s) => s.toUpperCase()} />),
    t.renderToStaticMarkup(<Card user={{ tags: [] }} />),
  ];
}
