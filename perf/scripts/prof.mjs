// Aggregate .cpuprofile files: self time by package/category, top functions, inclusive time of selected functions.
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2]; const filt = process.argv[3]; // optional pkg filter for top functions
const byPkg = new Map(), byFn = new Map(), incl = new Map(); let total = 0;
const WATCH = ['queryAllByRole','isInaccessible','getComputedStyle','computeAccessibleName','userEvent','dispatchEvent','createTheme','insertRule','serializeStyles','renderWithHooks','commitRoot'];
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith('.cpuprofile'))) {
  const p = JSON.parse(fs.readFileSync(path.join(dir,f)));
  const nodes = new Map(p.nodes.map(n=>[n.id,n])); const parent = new Map();
  for (const n of p.nodes) for (const c of n.children||[]) parent.set(c, n.id);
  const self = new Map(); const dt = p.timeDeltas; 
  for (let i=0;i<p.samples.length;i++) self.set(p.samples[i], (self.get(p.samples[i])||0) + (dt[i]||0)/1000);
  for (const [id, ms] of self) {
    const n = nodes.get(id); const u = n.callFrame.url; total += ms;
    let pkg = u.match(/node_modules\/((@[^/]+\/)?[^/]+)/)?.[1] ?? (u.startsWith('node:')? 'node-internal' : u.includes('/src/')||u.includes('/test/') ? 'project code' : u ? 'other:'+path.basename(u) : '(native/'+n.callFrame.functionName+')');
    if (pkg.startsWith('(native/(garbage')) pkg='(GC)'; if (pkg==='(native/(program)' || pkg==='(native/(idle)') pkg='(program/idle)';
    byPkg.set(pkg, (byPkg.get(pkg)||0)+ms);
    if (!filt || pkg.includes(filt)) { const k = (n.callFrame.functionName||'(anon)')+' '+pkg+'/'+path.basename(u)+':'+n.callFrame.lineNumber; byFn.set(k,(byFn.get(k)||0)+ms); }
    // inclusive: walk ancestors once per watched name
    const seen = new Set(); let cur = id;
    while (cur !== undefined) { const fn = nodes.get(cur).callFrame.functionName; for (const w of WATCH) if (fn===w && !seen.has(w)) { seen.add(w); incl.set(w,(incl.get(w)||0)+ms); } cur = parent.get(cur); }
  }
}
const top = (m,k)=>[...m].sort((a,b)=>b[1]-a[1]).slice(0,k);
console.log('total sampled ms', total.toFixed(0));
console.log('\n## self time by package'); for (const [k,v] of top(byPkg,20)) console.log(`${(v/total*100).toFixed(1).padStart(5)}%  ${v.toFixed(0).padStart(6)}ms  ${k}`);
console.log(`\n## top functions (self)${filt?' in '+filt:''}`); for (const [k,v] of top(byFn,12)) console.log(`${(v/total*100).toFixed(1).padStart(5)}%  ${v.toFixed(0).padStart(6)}ms  ${k}`);
console.log('\n## inclusive time of selected functions'); for (const [k,v] of top(incl,20)) console.log(`${(v/total*100).toFixed(1).padStart(5)}%  ${v.toFixed(0).padStart(6)}ms  ${k}`);
