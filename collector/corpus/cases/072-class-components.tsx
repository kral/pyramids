import { Component, createRef } from 'react';
const log: string[] = [];
class Clock extends Component<{ tick: number; label?: string }, { seen: number; derived?: string }> {
  static defaultProps = { label: 'dflt' };
  state = { seen: 0, derived: undefined as string | undefined };
  static getDerivedStateFromProps(p: { tick: number }, s: any) { return p.tick > 1000 ? /*@never*/ null : { derived: 'd' + p.tick }; }
  componentDidMount() { log.push('mount'); }
  componentDidUpdate(prev: { tick: number }) { if (prev.tick !== this.props.tick) log.push('update:' + prev.tick + '>' + this.props.tick); }
  componentWillUnmount() { log.push('unmount'); }
  shouldComponentUpdate(np: { tick: number }) { return np.tick !== 2; }
  bump = () => this.setState((s) => ({ seen: s.seen + 1 }), () => log.push('setState-cb:' + this.state.seen));
  render() { return <button onClick={this.bump}>{this.props.label}:{this.props.tick}:{this.state.seen}:{this.state.derived}</button>; }
}
export function scenario(t: any) {
  const ref = createRef<Clock>();
  const r = t.render(<Clock ref={ref} tick={1} />);
  t.fireEvent.click(r.getByRole('button'));
  r.rerender(<Clock ref={ref} tick={2} />);
  const mid = r.container.innerHTML;
  r.rerender(<Clock ref={ref} tick={3} label="L" />);
  const end = r.container.innerHTML;
  r.unmount();
  return { mid, end, log, isInst: ref.current === null };
}
