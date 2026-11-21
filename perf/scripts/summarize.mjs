import fs from 'node:fs';
const rows = fs.readFileSync('/home/claude/perf-lab/results.tsv','utf8').trim().split('\n').map(l=>l.split('\t'));
const med = a => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const g = {};
for (const [proj,label,r,wall,cpu,load,dur,tests,args] of rows) {
  const k = proj+'|'+label; (g[k] ??= {proj,label,wall:[],cpu:[],dur:[],tests,args});
  g[k].wall.push(+wall); if (cpu !== '-') g[k].cpu.push(+cpu); g[k].dur.push(dur);
}
const projs=[...new Set(Object.values(g).map(x=>x.proj))];
const refH = g['heavy|baseline'];
for (const proj of projs) {
  const list = Object.values(g).filter(x=>x.proj===proj);
  const b = list.find(x=>x.label==='baseline') ?? (proj.startsWith('heavy')? refH : null); if (!b) continue;
  const bc = med(b.cpu), bw = med(b.wall);
  console.log(`\n### ${proj} (subset .1.test = 39 files / 390 tests) — baseline CPU ${bc.toFixed(1)} s, wall ${bw.toFixed(1)} s`);
  console.log('| variant | n | CPU median (min–max) s | ΔCPU vs base | wall median (min–max) s | Δwall | Vitest breakdown (last run) | tests |');
  console.log('|---|---|---|---|---|---|---|---|');
  list.sort((x,y)=>(x.cpu.length?med(x.cpu):1e9)-(y.cpu.length?med(y.cpu):1e9));
  for (const x of list) {
    const c = x.cpu.length? med(x.cpu):null, w = med(x.wall);
    const pc = c? ((c/bc-1)*100).toFixed(0)+'%':'n/a', pw = ((w/bw-1)*100).toFixed(0)+'%';
    console.log(`| ${x.label} | ${x.wall.length} | ${c? c.toFixed(1)+' ('+Math.min(...x.cpu).toFixed(0)+'–'+Math.max(...x.cpu).toFixed(0)+')':'-'} | ${pc} | ${w.toFixed(1)} (${Math.min(...x.wall).toFixed(0)}–${Math.max(...x.wall).toFixed(0)}) | ${pw} | ${x.dur.at(-1)} | ${x.tests} |`);
  }
}
