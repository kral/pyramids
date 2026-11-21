// vto verify – output language. English by default; Czech with VTO_LANG=cs (or --lang cs).
// Verdict CODES in verify.json are language independent: confirmed | differs | not-refuted | unverifiable.
const T = {
  en: {
    verdict: { confirmed: 'confirmed redundant', differs: 'differs in assertions', 'not-refuted': 'not refuted', unverifiable: 'cannot verify', skipped: 'not verified' },
    ex: { failed: 'test failed', tainted: 'concurrent tests (tainted)', leaky: 'async work outlives the test (leaky)', contaminated: 'contaminated by a previous test', missing: 'test not found in raw data', skipped: 'test skipped' },
    reason: {
      excluded: (x) => `excluded: ${x}`,
      noMutants: 'no mutants in the covered blocks',
      notRun: 'mutants were not executed',
      baseFail: 'test failed without mutation during verification (unstable / order dependent)',
      noKill: 'no mutant was killed (assertions do not depend on mutated code)',
      fewMutants: (k, n) => `only ${k} mutant${k === 1 ? '' : 's'} (< ${n}) – too little evidence`,
      sampled: (k) => `mutants sampled (--max-mutants), ${k} used`,
      parametric: 'parametric test (same test line, e.g. it.each rows over different data) – code mutants cannot see data',
      dataDriven: (d) => `test bodies differ only in literals / data paths (${d}) – code mutants cannot see data`,
      inputsDiffer: (d) => `test A calls with arguments test B never uses (${d}) – a different input partition, mutation of branch-free code cannot tell them apart`,
      noStatic: 'test body could not be analysed statically (dynamic title, it.each, helper-generated test) – inputs cannot be compared',
      confirmed: (k, ka, kb) => `${k} mutants run on both; A killed ${ka}, B killed ${kb}, none only by A; same call arguments, bodies do not differ only in literals`,
    },
    notRefutedLabel: (k) => `not refuted (${k} mutant${k === 1 ? '' : 's'})`,
    log: {
      plan: (c, m, u, t, a, to) => `${c} candidates, ${m} mutants (${u} in candidate blocks), ${t} tests, ${a} test×mutant runs, timeout ${to} ms`,
      vitestCode: (c) => `vitest exited with code ${c}`,
      watchdog: (s) => `watchdog: stuck ${s} → resuming`,
      confirm: (r, f) => `confirmation round: ${r} decisive runs repeated, ${f} flaky`,
      done: (s, n, v, f) => `done in ${s} s: ${n} runs, ${v} → ${f}`,
      noUnits: (n, ex) => `none of the ${n} report units was found in the raw data (paths/root mismatch?). Example unit: ${ex}`,
      someMissing: (k, n) => `${k} of ${n} report units not found in the raw data`,
    },
  },
  cs: {
    verdict: { confirmed: 'potvrzeno redundantní', differs: 'liší se asercemi', 'not-refuted': 'nevyvráceno', unverifiable: 'nelze ověřit', skipped: 'neověřováno' },
    ex: { failed: 'test selhal', tainted: 'souběžné testy (tainted)', leaky: 'asynchronní práce přesahuje test (leaky)', contaminated: 'kontaminováno předchozím testem', missing: 'test nenalezen v raw datech', skipped: 'test přeskočen' },
    reason: {
      excluded: (x) => `vyloučeno: ${x}`,
      noMutants: 'v pokrytých blocích nejsou žádné mutanty',
      notRun: 'mutanti nebyli spuštěni',
      baseFail: 'test neprošel bez mutace při ověřování (nestabilní / závislý na pořadí)',
      noKill: 'žádný mutant nebyl zabit (aserce nezávisí na mutovaném kódu)',
      fewMutants: (k, n) => `jen ${k} mutantů (< ${n}) – málo důkazů`,
      sampled: (k) => `mutanti vzorkováni (--max-mutants), použito ${k}`,
      parametric: 'parametrický test (stejný řádek, např. řádky it.each nad různými daty) – mutanti kódu data nevidí',
      dataDriven: (d) => `těla testů se liší jen literály / datovými cestami (${d}) – mutanti kódu data nevidí`,
      inputsDiffer: (d) => `test A volá s argumenty, které test B nepoužívá (${d}) – jiná třída vstupů, mutace kódu bez větvení je nerozliší`,
      noStatic: 'tělo testu nelze staticky analyzovat (dynamický název, it.each, generovaný test) – vstupy nelze porovnat',
      confirmed: (k, ka, kb) => `${k} mutantů spuštěno na obou; A zabil ${ka}, B zabil ${kb}, žádného jen A; stejné argumenty volání, těla se neliší jen literály`,
    },
    notRefutedLabel: (k) => `nevyvráceno (${k} mutantů)`,
    log: {
      plan: (c, m, u, t, a, to) => `${c} kandidátů, ${m} mutantů (${u} v kandidátních blocích), ${t} testů, ${a} běhů test×mutant, timeout ${to} ms`,
      vitestCode: (c) => `vitest skončil s kódem ${c}`,
      watchdog: (s) => `watchdog: zaseknuté ${s} → pokračuji`,
      confirm: (r, f) => `potvrzovací kolo: ${r} rozhodujících běhů zopakováno, ${f} nestabilních`,
      done: (s, n, v, f) => `hotovo za ${s} s: ${n} běhů, ${v} → ${f}`,
      noUnits: (n, ex) => `žádná z ${n} jednotek reportu nebyla nalezena v raw datech (nesedí cesty / root?). Příklad: ${ex}`,
      someMissing: (k, n) => `${k} z ${n} jednotek reportu nenalezeno v raw datech`,
    },
  },
};

export function lang(argv = process.argv) {
  const i = argv.indexOf('--lang');
  const l = (i >= 0 ? argv[i + 1] : process.env.VTO_LANG) || 'en';
  return l.toLowerCase().startsWith('cs') ? 'cs' : 'en';
}
export const t = (l) => T[l] ?? T.en;
