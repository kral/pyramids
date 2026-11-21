// Optional, guarded performance patch for Ink's output buffer.
//
// Ink builds a fresh `Output` per frame and with it a fresh `OutputCaches`, so every visible
// line is ANSI-tokenized and split into styled cells again on every frame, even when it did not
// change. Profiling `vto ui` at 160×48 showed ~60 % of the frame time there. This patch makes the
// two cache lookups (`getStyledChars`, `getStringWidth`) consult a process-wide LRU first.
// Results are immutable inputs for Ink (it copies cells before changing them), so sharing them
// across frames is safe.
//
// Feature-detected: if Ink's internals change shape the patch is skipped (no behaviour change).
// Kill switch: VTO_UI_NO_INK_PATCH=1.

type Caches = { getStyledChars(line: string): unknown; getStringWidth(text: string): number };

let applied: boolean | null = null;

export async function patchInkOutputCaches(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (applied !== null) return applied;
  applied = false;
  if (env.VTO_UI_NO_INK_PATCH === '1') return false;
  try {
    // `ink` exports only "." (build/index.js); its sibling build/output.js is the very module
    // URL Ink itself imports, so importing it by URL yields the same module instance.
    const url = new URL('./output.js', import.meta.resolve('ink')).href;
    const mod = (await import(url)) as { default?: new (o: { width: number; height: number }) => { caches?: Caches } };
    const Output = mod.default;
    if (typeof Output !== 'function') return false;
    const probe = new Output({ width: 1, height: 1 });
    const proto = probe.caches && (Object.getPrototypeOf(probe.caches) as Caches);
    if (!proto || typeof proto.getStyledChars !== 'function' || typeof proto.getStringWidth !== 'function') return false;
    const origChars = proto.getStyledChars;
    const origWidth = proto.getStringWidth;
    const chars = new Map<string, unknown>();
    const widths = new Map<string, number>();
    const MAX = 8192;
    proto.getStyledChars = function (this: Caches, line: string) {
      let v = chars.get(line);
      if (v === undefined) {
        v = origChars.call(this, line);
        if (chars.size >= MAX) chars.delete(chars.keys().next().value as string);
        chars.set(line, v);
      }
      return v;
    };
    proto.getStringWidth = function (this: Caches, text: string) {
      let v = widths.get(text);
      if (v === undefined) {
        v = origWidth.call(this, text);
        if (widths.size >= MAX) widths.delete(widths.keys().next().value as string);
        widths.set(text, v);
      }
      return v;
    };
    applied = true;
    return true;
  } catch {
    return false;
  }
}
