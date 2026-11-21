const t0 = performance.now(); const cpu0 = process.cpuUsage();
for (const s of process.argv.slice(2)) await import(s);
const c = process.cpuUsage(cpu0);
console.log(process.argv.slice(2).join(' ').slice(0,80), 'wall', (performance.now()-t0).toFixed(0)+'ms', 'cpu', ((c.user+c.system)/1000).toFixed(0)+'ms');
