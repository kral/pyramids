//! All human-facing texts of report.md in one place. English is the default; Czech via
//! `--lang cs` or `VTO_LANG=cs`. Templates use `{}` placeholders filled in order by [`fill`].
//! report.json keys/values are language-independent.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    Cs,
}

impl Lang {
    pub fn parse(s: &str) -> Option<Lang> {
        match s.trim().to_ascii_lowercase().as_str() {
            "en" | "en-us" | "en-gb" | "english" => Some(Lang::En),
            "cs" | "cz" | "cs-cz" | "czech" | "čeština" => Some(Lang::Cs),
            _ => None,
        }
    }
    /// `--lang` value, else `VTO_LANG`, else English.
    pub fn resolve(cli: Option<&str>) -> Result<Lang, String> {
        match cli.map(str::to_string).or_else(|| std::env::var("VTO_LANG").ok().filter(|s| !s.is_empty())) {
            None => Ok(Lang::En),
            Some(s) => Lang::parse(&s).ok_or_else(|| format!("unsupported language {s:?} (supported: en, cs)")),
        }
    }
}

/// Replaces each `{}` in `tpl` with the next argument.
pub fn fill(tpl: &str, args: &[&dyn std::fmt::Display]) -> String {
    let mut out = String::with_capacity(tpl.len() + 16);
    let mut it = args.iter();
    let mut rest = tpl;
    while let Some(i) = rest.find("{}") {
        out.push_str(&rest[..i]);
        match it.next() {
            Some(a) => out.push_str(&a.to_string()),
            None => out.push_str("{}"),
        }
        rest = &rest[i + 2..];
    }
    out.push_str(rest);
    out
}

/// (key, English, Czech)
const T: &[(&str, &str, &str)] = &[
    ("items.v2", "instrumented blocks – statements, branches, functions", "instrumentované bloky – příkazy, větve, funkce"),
    ("items.v1", "code segments from V8 coverage + branches not taken", "úseky kódu z V8 coverage + nevykonané větve"),
    ("title", "# Vitest – overlapping tests report\n\n", "# Vitest – report překrývajících se testů\n\n"),
    ("generated", "Generated {} · {} tests ({} evaluated) · {} covered items in total ({}).\n\n",
        "Vygenerováno {} · {} testů ({} vyhodnocených) · celkem {} pokrytých položek ({}).\n\n"),
    ("disclaimer",
        "> **This is not a list of tests to delete.** Code coverage sees neither data nor assertions: two tests with identical coverage may check different values (boundary cases `99` / `100`, a different text in `{label}`, different `expect`s). All findings are *candidates for review* with a stated reason; the decision belongs to a human.\n\n",
        "> **Nejde o seznam testů ke smazání.** Pokrytí kódu nevidí data ani aserce: dva testy se shodným pokrytím mohou ověřovat jiné hodnoty (hraniční případy `99` / `100`, jiný text v `{label}`, jiné `expect`). Všechny nálezy jsou *kandidáti k revizi* s uvedeným důvodem; rozhodnutí patří člověku.\n\n"),
    ("summary.head", "## Summary\n\n| Metric | Value |\n|---|---|\n", "## Souhrn\n\n| Metrika | Hodnota |\n|---|---|\n"),
    ("summary.identical", "| Groups of tests with identical coverage | {} ({} tests) |", "| Skupiny testů se shodným pokrytím | {} ({} testů) |"),
    ("summary.subsumed", "| Tests whose coverage is contained in another test | {} |", "| Testy, jejichž pokrytí je obsaženo v jiném testu | {} |"),
    ("summary.near", "| Near-identical pairs (Jaccard ≥ {}) | {} |", "| Téměř shodné dvojice (Jaccard ≥ {}) | {} |"),
    ("summary.minset", "| Minimal set keeping 100 % coverage (statistic) | {} of {} evaluated tests |",
        "| Minimální sada držící 100 % pokrytí (statistika) | {} z {} vyhodnocených testů |"),
    ("summary.nocov", "| Cannot be evaluated (no coverage recorded) | {} |", "| Nelze vyhodnotit (žádné zaznamenané pokrytí) | {} |"),
    ("summary.excluded", "| Excluded from evaluation (failed, skipped, tainted, leaky) | {} |",
        "| Vyřazené z vyhodnocení (selhané, přeskočené, tainted, leaky) | {} |"),
    ("summary.noasr", "| Tests without assertions | {} |", "| Testy bez asercí | {} |"),
    ("summary.time", "| Time of evaluated tests | {} |", "| Čas vyhodnocených testů | {} |"),
    ("summary.slow", "| Of which tests without unique coverage | {} ({} tests) |", "| Z toho testy bez unikátního pokrytí | {} ({} testů) |"),
    ("review",
        "## Candidates for review\n\nReasons (strongest first): `same-coverage+same-assertions+same-dom` – identical coverage, assertions and resulting DOM; `same-coverage+same-assertions`; `same-coverage` – only the coverage is identical; `subset` – the coverage is a subset of another test; `near` – similar coverage (Jaccard). Without assertion/DOM fingerprints (the collector does not send them yet) the highest available tier is `same-coverage`. `parametric` (weakest, listed last) – rows of one `it.each` / generated test on the same line: identical coverage is expected, the rows differ in data.\n\n> Coverage is blind to data: tests that differ only in JSON fixtures, literals or expected values look identical here.\n\n",
        "## Kandidáti k revizi\n\nDůvody (od nejsilnějšího): `same-coverage+same-assertions+same-dom` – shodné pokrytí, aserce i výsledné DOM; `same-coverage+same-assertions`; `same-coverage` – shodné jen pokrytí; `subset` – pokrytí je podmnožinou jiného testu; `near` – podobné pokrytí (Jaccard). Bez otisků asercí/DOM (collector je zatím neposílá) je nejvyšší dostupná úroveň `same-coverage`. `parametric` (nejslabší, uvedeno na konci) – řádky jednoho `it.each` / generovaného testu na stejném řádku: shodné pokrytí je očekávané, řádky se liší daty.\n\n> Pokrytí nevidí data: testy, které se liší jen JSON fixturami, literály nebo očekávanými hodnotami, zde vypadají shodně.\n\n"),
    ("identical",
        "## Identical coverage\n\nThese tests run exactly the same code. Check whether they verify something different (values, assertions); if not, consider merging them into `it.each`.\n\n",
        "## Shodné pokrytí\n\nTyto testy procházejí přesně stejným kódem. Zkontroluj, zda ověřují něco jiného (hodnoty, aserce); pokud ne, zvaž sloučení do `it.each`.\n\n"),
    ("identical.group", "### Group {} ({} tests, {} covered items{}, reason: `{}`)", "### Skupina {} ({} testů, {} pokrytých položek{}, důvod: `{}`)"),
    ("identical.group.time", ", {} beyond the slowest test", ", {} nad rámec nejpomalejšího testu"),
    ("more.groups", "… and {} more groups ({} tests) – run with `--full` or see report.json.", "… a dalších {} skupin ({} testů) – spusť s `--full` nebo viz report.json."),
    ("more.in.group", "- … and {} more tests", "- … a dalších {} testů"),
    ("compact.note",
        "> Compact report: lists are cut to the most relevant entries and the per-test table is left out. `--full` writes everything; report.json is always complete.\n\n",
        "> Zkrácený report: seznamy obsahují jen nejdůležitější položky a tabulka všech testů je vynechána. `--full` vypíše vše; report.json je vždy úplný.\n\n"),
    ("all.omitted",
        "## All tests\n\nThe table of all {} tests is not part of the compact report – run with `--full`, or read `tests[]` in report.json.\n",
        "## Všechny testy\n\nTabulka všech {} testů není součástí zkráceného reportu – spusť s `--full`, nebo čti `tests[]` v report.json.\n"),
    ("subsumed",
        "## Fully contained in another test\n\nEverything this test covers is also covered by another, broader test (reason: `subset`). The broader test may still not verify the same thing.\n\n| Test | Contained in (smallest supersets) | Items |\n|---|---|---|\n",
        "## Plně obsažené v jiném testu\n\nVše, co test pokrývá, pokrývá i jiný, širší test (důvod: `subset`). Širší test ale nemusí ověřovat totéž.\n\n| Test | Obsažen v (nejmenší nadmnožiny) | Položky |\n|---|---|---|\n"),
    ("more.tests.json", "\n… and {} more tests (see report.json).", "\n… a dalších {} testů (viz report.json)."),
    ("total.tests", "<br>… {} tests in total", "<br>… celkem {} testů"),
    ("near",
        "## Near-identical pairs\n\nReason `near`. Pairs are between classes of identical coverage – \"(+n)\" means n more tests have exactly the same coverage (see Identical coverage).\n\n",
        "## Téměř shodné dvojice\n\nDůvod `near`. Dvojice jsou mezi třídami shodného pokrytí – „(+n)“ znamená, že stejné pokrytí má ještě n dalších testů (viz Shodné pokrytí).\n\n"),
    ("near.common",
        "Similarity is computed without {} common items covered by most tests (shared setup, \"app shell\"); Jaccard 100 % here means everything else is identical.\n\n",
        "Podobnost se počítá bez {} společných položek, které pokrývá většina testů (sdílený setup, „app shell“); Jaccard 100 % zde znamená shodu ve všem ostatním.\n\n"),
    ("near.truncated", "> ⚠ The search stopped at the candidate limit (`--max-near-candidates`) – the list is incomplete.\n\n",
        "> ⚠ Hledání bylo zastaveno po dosažení limitu kandidátů (`--max-near-candidates`) – seznam je neúplný.\n\n"),
    ("near.shown", "Showing {} of {} pairs found (report.json contains at most {}).\n\n", "Zobrazeno {} z {} nalezených dvojic (report.json obsahuje nejvýše {}).\n\n"),
    ("near.head", "| Test A | Test B | Jaccard | A in B | B in A |\n|---|---|---|---|---|\n", "| Test A | Test B | Jaccard | A v B | B v A |\n|---|---|---|---|---|\n"),
    ("minset",
        "## Minimal test set\n\nStatistic only: a greedy set cover finds {} tests that together cover all {} items{}. The choice of concrete tests is approximate and depends on order, so it is not listed – coverage does not see what tests verify.\n\n",
        "## Minimální sada testů\n\nJen statistika: hladový set cover najde {} testů, které dohromady pokryjí všech {} položek{}. Výběr konkrétních testů je přibližný a závisí na pořadí, proto se nevypisuje – pokrytí nevidí, co testy ověřují.\n\n"),
    ("minset.time", " (their run time {} of {})", " (jejich doba běhu {} z {})"),
    ("nocov",
        "## Cannot be evaluated\n\nNo coverage was recorded for these tests. Possible causes: the test only checks code executed at import time (constants, configuration, schemas), works only with mocks, the source is not instrumented, or coverage was lost (async work after the end of the test). **This does not mean the test is useless.**\n\n{}\n\n",
        "## Nelze vyhodnotit\n\nU těchto testů nebylo zaznamenáno žádné pokrytí. Možné příčiny: test ověřuje jen kód vykonaný při importu (konstanty, konfigurace, schémata), pracuje jen s mocky, zdroj není instrumentován, nebo se pokrytí ztratilo (asynchronní práce po konci testu). **Neznamená to, že je test zbytečný.**\n\n{}\n\n"),
    ("excluded",
        "## Excluded from evaluation\n\nThese tests take part in no conclusion (their coverage is incomplete or unreliable).\n\n{}\n\n",
        "## Vyřazené z vyhodnocení\n\nTyto testy se neúčastní žádného závěru (jejich pokrytí je neúplné nebo nespolehlivé).\n\n{}\n\n"),
    ("slow",
        "## Slow tests without unique coverage\n\nEvaluated tests whose items are also covered by some other test, sorted by run time ({} in total). This is time worth reviewing – **not a saving**: a test may verify something coverage cannot see, and one test of every identical group must always stay. The duration of the first test in a file includes module import and warm-up (marked *).\n\n| Test | Duration | Items |\n|---|---|---|\n",
        "## Pomalé testy bez unikátního pokrytí\n\nVyhodnocené testy, jejichž položky pokrývá i nějaký jiný test, seřazené podle doby běhu (celkem {}). Je to čas, který stojí za revizi – **ne úspora**: test může ověřovat něco, co pokrytí nevidí, a ze skupiny shodných testů musí vždy jeden zůstat. Doba prvního testu v souboru obsahuje import modulů a zahřátí (označeno *).\n\n| Test | Doba | Položky |\n|---|---|---|\n"),
    ("more.tests", "\n… and {} more tests.", "\n… a dalších {} testů."),
    ("noasr",
        "## Tests without assertions\n\nTests that ran no `expect` – they execute code but verify nothing (unless it is a \"does not throw\" test).\n\n{}\n\n",
        "## Testy bez asercí\n\nTesty, které neprovedly žádné `expect` – kód spustí, ale nic neověřují (pokud nejde o test „nespadne“).\n\n{}\n\n"),
    ("noasr.item", "- {} — items: {}, unique: {}", "- {} — položek: {}, unikátních: {}"),
    ("all.head", "## All tests\n\n| Test | Items | Unique | Unique lines |", "## Všechny testy\n\n| Test | Položky | Unikátní | Unikátní řádky |"),
    ("all.dur", " Duration |", " Doba |"),
    ("all.asr", " Assertions |", " Aserce |"),
    ("all.excluded", " ⚠ excluded: {}", " ⚠ vyřazen: {}"),
    ("imports",
        "## Unnecessary imports\n\nModules that were loaded for a test file (incl. transitive imports) but of which no test in that file executed a single block (code run only at import time does not count). Candidates for `vi.mock`, a direct import instead of a barrel, or splitting the module. Modules without instrumented blocks (barrels, JSON, CSS) cannot be checked – they are marked \"no blocks\".\n\n",
        "## Zbytečné importy\n\nModuly, které se pro testovací soubor načetly (vč. tranzitivních importů), ale žádný test v tom souboru z nich nevykonal ani jeden blok (kód spuštěný jen při importu se nepočítá). Kandidáti na `vi.mock`, přímý import místo barrelu nebo rozdělení modulu. Moduly bez instrumentovaných bloků (barrely, JSON, CSS) nelze ověřit – jsou označeny „bez bloků“.\n\n"),
    ("imports.none", "None found.\n\n", "Žádné nalezeny.\n\n"),
    ("imports.suspects", "### Suspicious modules (across the suite)\n\nLoaded by many test files but used in few of them", "### Podezřelé moduly (napříč sadou)\n\nNačítané mnoha testovacími soubory, ale používané v málo z nich"),
    ("imports.byload", "; sorted by total load time (loadMs × number of files).\n\n", "; seřazeno podle celkové doby načítání (loadMs × počet souborů).\n\n"),
    ("imports.head", "| Module | Loaded in files | Used in | Note |", "| Modul | Načten v souborech | Použit v | Poznámka |"),
    ("imports.loadcol", " Total load time |", " Načítání celkem |"),
    ("imports.noblocks", "no blocks", "bez bloků"),
    ("imports.more", "\n… and {} more modules.", "\n… a dalších {} modulů."),
    ("imports.byfile", "\n### By test file\n\n| Test file | Unused modules | Modules loaded |\n|---|---|---|\n",
        "\n### Podle testovacích souborů\n\n| Testovací soubor | Nepoužité moduly | Načteno modulů |\n|---|---|---|\n"),
    ("more.n", "<br>… and {} more", "<br>… a dalších {}"),
    ("more.files", "\n… and {} more files.", "\n… a dalších {} souborů."),
    // exclusion reasons (codes in report.json)
    ("reason.failed", "failed", "selhal"),
    ("reason.skipped", "skipped", "přeskočen"),
    ("reason.tainted", "ran concurrently with another test (tainted)", "souběh s jiným testem (tainted)"),
    ("reason.leaky", "async work outlives the test (leaky)", "asynchronní práce přesahuje konec testu (leaky)"),
];

/// Text for `key` in `lang` (panics in debug on an unknown key; the key itself in release).
pub fn t(lang: Lang, key: &str) -> &'static str {
    match T.iter().find(|e| e.0 == key) {
        Some(e) => match lang {
            Lang::En => e.1,
            Lang::Cs => e.2,
        },
        None => {
            debug_assert!(false, "missing i18n key {key}");
            ""
        }
    }
}

/// `t` + [`fill`].
pub fn tf(lang: Lang, key: &str, args: &[&dyn std::fmt::Display]) -> String {
    fill(t(lang, key), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_has_both_languages_and_same_placeholders() {
        let mut seen = std::collections::HashSet::new();
        for (k, en, cs) in T {
            assert!(seen.insert(*k), "duplicate key {k}");
            assert!(!en.is_empty() && !cs.is_empty(), "{k}");
            assert_eq!(en.matches("{}").count(), cs.matches("{}").count(), "placeholders differ for {k}");
        }
    }

    #[test]
    fn fill_and_parse() {
        assert_eq!(fill("a {} b {}", &[&1, &"x"]), "a 1 b x");
        assert_eq!(fill("{label} {}", &[&2]), "{label} 2");
        assert_eq!(Lang::parse("CS"), Some(Lang::Cs));
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("de"), None);
        assert_eq!(t(Lang::Cs, "summary.head").lines().next(), Some("## Souhrn"));
        assert_eq!(t(Lang::En, "summary.head").lines().next(), Some("## Summary"));
    }
}
