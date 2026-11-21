// Error helpers shared by every engine module.
export function userError(msg) { const e = new Error(msg); e.code = 'E_USER'; return e; }
