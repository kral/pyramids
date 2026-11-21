import { Component, type ReactNode } from 'react';
const log: string[] = [];
class Boundary extends Component<{ children: ReactNode; fallback?: string }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) { return { err: e.message }; }
  componentDidCatch(e: Error) { log.push('didCatch:' + e.message); }
  render() { return this.state.err ? <p role="alert">{this.props.fallback ?? 'Error'}: {this.state.err}</p> : this.props.children; }
}
function Bomb({ when }: { when: boolean }) { if (when) throw new Error('kaboom'); return <span>safe</span>; }
export function scenario(t: any) {
  const r1 = t.render(<Boundary fallback="FB"><Bomb when /></Boundary>);
  const a = r1.container.innerHTML;
  const r2 = t.render(<Boundary><Bomb when={false} /></Boundary>);
  return { a, b: r2.container.innerHTML, log, never: log.length > 10 ? /*@never*/ 'x' : 'ok' };
}
