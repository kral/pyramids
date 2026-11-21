export async function open() { const m = await import('./page'); return m.render(); }
