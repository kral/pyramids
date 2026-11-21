// verify.md from verify.json – English by default, Czech with lang 'cs'
import { cell as esc } from './sanitize.mjs';
// `esc` = full Markdown/HTML escaping (S-F10); the only markup in a cell is the `<br>` this file adds.
const short = (id) => id.replace(/^(.*?):(\d+) > /, '$1:$2 › ');

const TX = {
  en: {
    title: '# vto verify – mutation check of redundancy candidates',
    intro: (d, s) => `Generated ${d}. Strategy \`${s}\`: all mutants of a file compiled into one module (mutant schemata); each test is re-run inside its worker once per active mutant. Only tests covering the mutated block run.`,
    how: '> **Reading the verdicts.** A pair *A ⊂ B* (or a same-coverage group) is **confirmed redundant** when every mutant killed by A is also killed by B, with enough mutants (≥ min), no sign of data-driven variants (bodies that differ only in literals, including signs and numbers) and no call that A makes with arguments B never uses. ' +
      '**Differs in assertions**: A kills a mutant that B survives – A checks something extra, keep it. ' +
      '**Not refuted (k mutants)**: mutation found no difference, but the evidence cannot see one – parametric tests (`it.each` rows), test bodies differing only in literals / data files, calls with different arguments, or too few mutants. Review by hand. ' +
      '**Cannot verify**: no mutants, nothing killed, or the test is excluded (failed / tainted / leaky). ' +
      'Even a confirmed pair is not proof – mutation operators do not model every fault (e.g. data values). It is a stronger review candidate, never a deletion list.',
    summary: '## Summary', metric: '| Metric | Value |',
    rows: { cand: 'Candidates (groups + pairs from report.json)', pairs: 'Ordered pairs verified', muts: 'Mutants generated / in candidate blocks',
      tests: 'Tests verified', runs: 'Test × mutant runs (planned / executed / killed)', tpm: 'Tests per mutant (mean / max)',
      to: 'Timeouts / hangs (counted as kills)', vr: 'Vitest runs / watchdog interventions', time: 'Total time' },
    diffH: '## Differs in assertions – keep', diffT: 'The left test kills mutants the other one survives.',
    diffCols: '| Test A | Test B | Mutants killed only by A |',
    okH: '## Confirmed redundant – candidates for merging',
    okT: 'Test A adds nothing that mutation can see over test B, and the two tests feed the code the same inputs. Read both before merging: mutation operators do not model every fault.',
    okCols: '| Kind | Test A (candidate to drop) | Test B (covers it) | Evidence |',
    okWhy: (p) => `${p.executed} mutants run on both; A killed ${p.killedA}, B killed ${p.killedB}, none only by A`,
    nrH: '## Not refuted – mutation cannot decide, review by hand', nrCols: '| Test A | Test B | Why not confirmed |',
    naH: '## Cannot verify', naCols: '| Tests | Reason |',
    kindSame: 'same coverage', kindSub: 'A ⊂ B',
  },
  cs: {
    title: '# vto verify – ověření kandidátů na redundanci mutačním testováním',
    intro: (d, s) => `Vygenerováno ${d}. Strategie \`${s}\`: všechny mutanty souboru v jednom modulu (mutant schemata), testy se pro každý aktivní mutant opakují uvnitř workeru. Spouštějí se jen testy, které mutovaný blok pokrývají.`,
    how: '> **Jak číst verdikty.** Dvojice *A ⊂ B* (nebo skupina se shodným pokrytím) je **potvrzena**, když každý mutant zabitý testem A zabije i B, mutantů je dost (≥ min), nejde o datové varianty (těla lišící se jen literály včetně znamének a čísel) a A nevolá nic s argumenty, které B nepoužívá. ' +
      '**Liší se asercemi**: A zabije mutanta, kterého B přežije – A ověřuje něco navíc, ponech ho. ' +
      '**Nevyvráceno (k mutantů)**: mutace rozdíl nenašla, ale ani ho najít nemohla – parametrické testy (řádky `it.each`), těla testů lišící se jen literály / datovými soubory, volání s jinými argumenty, nebo málo mutantů. Zkontroluj ručně. ' +
      '**Nelze ověřit**: žádní mutanti, nic nezabito, nebo je test vyloučen (selhal, tainted, leaky). ' +
      'Ani potvrzená dvojice není důkaz – operátory mutací nemodelují všechny chyby (např. hodnoty v datech). Ber jako silnějšího kandidáta k revizi, ne jako seznam ke smazání.',
    summary: '## Souhrn', metric: '| Metrika | Hodnota |',
    rows: { cand: 'Kandidáti (skupiny + dvojice z report.json)', pairs: 'Ověřované uspořádané dvojice', muts: 'Mutanti vygenerovaní / v kandidátních blocích',
      tests: 'Testy ve verifikaci', runs: 'Běhy test × mutant (plán / provedeno / zabito)', tpm: 'Testů na mutanta (průměr / max)',
      to: 'Timeouty / zaseknutí (počítáno jako zabití)', vr: 'Spuštění Vitestu / zásahy watchdogu', time: 'Celkový čas' },
    diffH: '## Liší se asercemi – ponechat', diffT: 'Test vlevo zabíjí mutanty, které druhý test přežije.',
    diffCols: '| Test A | Test B | Mutanti zabití jen testem A |',
    okH: '## Potvrzeno redundantní – kandidáti ke sloučení',
    okT: 'Test A nepřidává oproti testu B nic, co mutace vidí, a oba testy dávají kódu stejné vstupy. Před sloučením si oba přečtěte: operátory mutací nemodelují každou chybu.',
    okCols: '| Typ | Test A (kandidát k odstranění) | Test B (pokrývá ho) | Důkaz |',
    okWhy: (p) => `${p.executed} mutantů spuštěno na obou; A zabil ${p.killedA}, B zabil ${p.killedB}, žádného jen A`,
    nrH: '## Nevyvráceno – mutace nerozhodne, zkontroluj ručně', nrCols: '| Test A | Test B | Proč nepotvrzeno |',
    naH: '## Nelze ověřit', naCols: '| Testy | Důvod |',
    kindSame: 'shodné pokrytí', kindSub: 'A ⊂ B',
  },
};

export function markdown(j, lang = 'en') {
  const X = TX[lang] ?? TX.en;
  const s = j.stats;
  let md = `${X.title}\n\n${X.intro(esc(j.generatedAt), esc(s.strategy))}\n\n${X.how}\n\n`;
  md += `${X.summary}\n\n${X.metric}\n|---|---|\n`;
  md += `| ${X.rows.cand} | ${s.candidates} |\n| ${X.rows.pairs} | ${s.pairs} |\n`;
  for (const [k, v] of Object.entries(s.verdicts)) md += `| – ${esc(s.verdictLabels?.[k] ?? k)} | ${Number(v)} |\n`;
  md += `| ${X.rows.muts} | ${s.mutantsGenerated} / ${s.mutantsUsed} |\n| ${X.rows.tests} | ${s.testsPlanned} |\n`;
  md += `| ${X.rows.runs} | ${s.attemptsPlanned} / ${s.attemptsExecuted} / ${s.attemptsKilled} |\n`;
  if (s.testsPerMutant) md += `| ${X.rows.tpm} | ${s.testsPerMutant.mean} / ${s.testsPerMutant.max} |\n`;
  md += `| ${X.rows.to} | ${s.timeouts} |\n| ${X.rows.vr} | ${s.vitestRuns} / ${s.watchdogKills} |\n`;
  md += `| ${X.rows.time} | ${(s.timing.total / 1000).toFixed(1)} s |\n\n`;
  const allPairs = j.candidates.flatMap((c) => c.pairs.map((p) => ({ ...p, c })));
  const diff = allPairs.filter((p) => p.verdict === 'differs');
  if (diff.length) {
    md += `${X.diffH}\n\n${X.diffT}\n\n${X.diffCols}\n|---|---|---|\n`;
    for (const p of diff) {
      const ms = p.onlyA.slice(0, 3).map((m) => esc(`${m.file}:${m.line} ${m.desc}`)).join('<br>') + (p.onlyA.length > 3 ? `<br>… +${p.onlyA.length - 3}` : '');
      md += `| ${esc(short(p.a))} | ${esc(short(p.b))} | ${ms} |\n`;
    }
    md += '\n';
  }
  // every confirmed PAIR is listed with its evidence (C-M8: the summary count alone is not reviewable)
  const ok = allPairs.filter((p) => p.verdict === 'confirmed');
  if (ok.length) {
    md += `${X.okH}\n\n${X.okT}\n\n${X.okCols}\n|---|---|---|---|\n`;
    for (const p of ok) {
      md += `| ${p.type === 'identical' ? X.kindSame : X.kindSub} | ${esc(short(p.a))} | ${esc(short(p.b))} | ${esc(p.reason ?? X.okWhy(p))} |\n`;
    }
    md += '\n';
  }
  const nr = allPairs.filter((p) => p.verdict === 'not-refuted');
  if (nr.length) {
    md += `${X.nrH}\n\n${X.nrCols}\n|---|---|---|\n`;
    for (const p of nr) md += `| ${esc(short(p.a))} | ${esc(short(p.b))} | ${esc(`${p.label}: ${p.reason}`)} |\n`;
    md += '\n';
  }
  const na = j.candidates.filter((c) => c.verdict === 'unverifiable');
  if (na.length) {
    md += `${X.naH}\n\n${X.naCols}\n|---|---|\n`;
    for (const c of na) {
      const reasons = [...new Set([c.reason, ...c.pairs.map((p) => p.reason)].filter(Boolean))].join('; ');
      md += `| ${c.units.map((u) => esc(short(u))).join('<br>')} | ${esc(reasons)} |\n`;
    }
    md += '\n';
  }
  return md;
}
