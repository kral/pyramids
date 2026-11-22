// vitest-guard mode of a lane, as shown in run labels ("pool vitest-guard:vm +quarantine").
// vitest-guard adds a sibling project per fast project for quarantined files (mode 'isolated', name '…:isolated');
// that sibling must not decide the label, or a mostly-vm run reads as "isolated".

/** projects: [{ name, provide }] (Vitest project configs) → { mode, quarantine } or null when not guarded */
export function summarizeGuard(projects) {
  const main = new Set();
  let quarantine = false, any = false;
  for (const p of projects) {
    const mode = p?.provide?.vitestGuard?.mode;
    if (!mode) continue;
    any = true;
    const name = typeof p.name === 'object' && p.name ? p.name.label : p.name; // Vitest allows { label, color }
    if (mode === 'isolated' && String(name || '').endsWith(':isolated')) quarantine = true;
    else main.add(mode);
  }
  if (!any) return null;
  return { mode: main.size ? [...main].sort().join('+') : 'isolated', quarantine };
}

/** label of one lane: info = { pool, vitestGuard, vitestGuardQuarantine } from the lane's ready message */
export function guardLabel(info) {
  if (!info) return null;
  return info.vitestGuard ? `vitest-guard:${info.vitestGuard}${info.vitestGuardQuarantine ? ' +quarantine' : ''}` : info.pool;
}
