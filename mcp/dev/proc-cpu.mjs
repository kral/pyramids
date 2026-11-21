#!/usr/bin/env node
// Linux only: CPU ms (user+sys) of a process tree incl. reaped children (cutime/cstime).
//   node dev/proc-cpu.mjs <pid>   → prints ms
import fs from 'node:fs';
const HZ = 100;
export function treeCpuMs(pid) {
  let total = 0;
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); const ppid = +f[1]; (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push([+d, f]); } catch {}
  }
  const self = (() => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' '); } catch { return null; } })();
  if (!self) return null;
  const add = (f) => (+f[11] + +f[12] + +f[13] + +f[14]) * 1000 / HZ; // utime stime cutime cstime
  total += add(self);
  const walk = (p) => { for (const [c, f] of kids.get(p) || []) { total += add(f); walk(c); } };
  walk(pid);
  return total;
}
if (process.argv[2]) console.log(treeCpuMs(+process.argv[2]));
