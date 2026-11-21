# vto daemon + MCP server (česky)

Zpětná vazba z testů během sekund místo celého `vitest run`, a odpovědi tak malé, aby se vešly AI agentům.
vto drží mapu pokrytí po jednotlivých testech (collector v2, `../collector`), vybere testy dotčené změnou
(Rust analyzer, `../analyzer`), spustí jen ty v zahřátém Vitestu, posílá selhání průběžně během běhu a po
každém běhu mapu opraví.

Výchozí jazyk dokumentace a výstupů je angličtina ([README.md](README.md)); tento soubor je česká verze.
Protokol pro klienty (TUI, VS Code): [PROTOCOL.md](PROTOCOL.md). Vzorce úspor: [SAVINGS.md](SAVINGS.md).

> **Spouštění testů přes vto spouští kód projektu**, stejně jako `npx vitest`. Povolit MCP nástroje
> `run_*` / `start_run` / `rerun_failed` znamená povolit `npx vitest` v tomto repozitáři.

## Vrstvy

| vrstva | vstup | co přidává |
|---|---|---|
| jádro (bezstavové) | `src/engine.mjs` + `src/api.mjs` | mapa (`.vto/`), výběr testů, běhy ve vlastním procesu s Vitestem („lane“), kompaktní výstup, redakce tajemství |
| CLI bez démona | `vto-daemon run-affected`, `ci-report`, cokoli s `--no-daemon` | stejná pravidla výstupu, studený Vitest při každém volání |
| MCP server | `bin/vto-mcp.mjs` | použije démona (spustí ho líně), jinak jádro ve vlastním procesu |
| démon | `bin/vto-daemon.mjs serve` (spouští se sám) | zahřáté lanes, proud událostí (selhání hned, jak nastanou), fix loop, živé pokrytí, fronta úkolů, ukončení po nečinnosti (30 min) |

Lanes jsou samostatné procesy Node, každý s jednou instancí `createVitest`: `main` (dotčené/plné/explicitní
běhy s instrumentací), `fix` (opakování selhaných testů, zatímco hlavní běh pokračuje; 1 worker) a `clean`
(`instrumented: false`, např. závěrečná kontrola před commitem – mapa se nemění).

## Měření na bench-project (312 souborů / 3195 testů, React 19 + RTL + jsdom)

2 sdílená jádra, souběžně běží další agenti (load 4–10): spolehlivá metrika je **CPU**, wall je orientační.

### Celá sada

| běh | pool | wall | CPU |
|---|---|---|---|
| `npx vitest run` (holý, default reporter) | forks (výchozí Vitest) | 698 s | 308,5 s |
| první studený běh vto = plný sběr mapy (s instrumentací) | forks | 455 s | 305 s |
| první studený běh vto = plný sběr mapy | vm-guard `vm` (vmThreads) | 71 s | 47 s |
| `npx vitest run` s vm-guard konfigurací (referenční běhy kontroly recall) | vm-guard `vm` | 49–58 s | – |

Instrumentace a collector na celé sadě nestojí měřitelné CPU (305 vs 308,5 s, v rámci šumu).

### Jedna úprava → dotčené testy (pool forks)

| scénář | vybráno | holý `vitest run <soubory>` | vto bez démona | vto zahřátý démon |
|---|---|---|---|---|
| CartBadge, úprava bez změny chování | 80 / 3174 testů, 8 souborů | 7,3 s / 7,1 s CPU | 11,2 s / 7,3 s CPU | 10,8 s / 7,6 s CPU |
| CartBadge, rozbíjející úprava (19 selhání) | 80, 8 souborů | 9,9 s / 7,4 s CPU | 9,6 s / 7,6 s CPU | 9,2 s / 7,1 s CPU, první selhání po 1,3 s |
| hook useQuantity, změna hranice | 61 (67 spuštěno) | 8,8 s / 8,2 s CPU | 8,9 s / 8,3 s CPU | 7,2 s / 8,1 s CPU |
| api/client.ts, konstanta na top-levelu (modul mockovaný) | 400, 40 souborů | 44,9 s / 37,6 s CPU | 46,0 s / 39,7 s CPU | 46,4 s / 40,0 s CPU |

Proti plnému běhu: **o 98 % méně CPU** pro úpravu komponenty, o 87 % pro široce importovaný modul.

**Zahřátý démon proti bezstavovému běhu: s poolem forks žádná úspora CPU** (±5 %, šum). Jak předpovídá
ARCHITECTURE.md (ADR-7), ≈80 % ceny je prostředí jsdom a vyhodnocení modulů pro každý soubor, které
zahřátý hlavní proces při `isolate: true` neudrží. Démon přináší: žádný start Vitestu/Vite při volání
(~1–2 s wall), selhání *během* běhu (první selhání po 1,3 s proti 9,2 s celého běhu), fix loop, živé
pokrytí a mapu v paměti. Velké páky jsou výběr testů a pool (vm-guard `vm`).

S poolem vm-guard `vm`: úprava komponenty (80 testů) za **1,9 s** (holý `vitest run <soubory>` 2,2 s, bez démona 2,0 s)
proti 56–71 s celé sady (−97 %) a 698 s / 308 s CPU výchozího Vitestu (forks). Rozdíl zahřátý/studený je jen 0,1–0,8 s.

Čas do prvního selhání (celá sada, vm-guard): selhání v souboru na pozici 174/312 přijde po 40,8 s místo 56,7 s
(konec běhu); na pozici 306/312 bez zisku. Pořadí souborů určuje sekvencer Vitestu.

Objem událostí: celý běh pošle 3195 událostí `test` (494 KB) a 349 událostí `coverage` (2,7 MB, max 14 KB);
běh dotčených testů (80 testů) 103 událostí / 31 KB. Pokrytí se počítá, jen když ho někdo odebírá; běh to nezpomalí.

### Tokeny (≈ znaky/4) pro stejný běh

| běh | vto MCP | agentní výchozí reporter Vitestu (`minimal`, Vitest 5 ho volí pod Claude Code) | default | verbose |
|---|---|---|---|---|
| 80 testů projde | **88** | 126 | 224 | 1 990 |
| 80 testů, 19 selhání | **789** (5 skupin) + 222 za `why_failed` | 2 721 | 3 285 | 4 439 |
| 400 testů projde | **90** | 122 | 656 | 11 578 |

Poctivě: u zelených běhů je agentní reporter Vitestu 5 už malý (≈120 tokenů); přínos vto je tam 98 % CPU a času,
ne tokeny. U selhání je vto 3,4× menší (seskupení, ≤3 rámce, krátké diffy) a detaily si agent bere jen pro test, na kterém pracuje.

### Správnost (kontrola recall)

`node dev/recall.mjs` – náhodné jednořádkové mutace v `src/` (operátory z faultinject), po každé zahřátý
`run_affected` a plný referenční běh bez vto (stejná vm-guard konfigurace): **10 mutantů, 6 zabitých, 171 testů
selhalo v plném běhu, všech 171 bylo vybráno (recall 100 %), 0 rozdílů ve stavu testů**, žádný „run all“,
průměrně vybráno 74 z 3174 testů (2,3 %), vto 8,6 s proti 58 s plného běhu (průměr; jeden mutant s timeouty 61 s).

## Nastavení pro Claude Code

Požadavky: Node ≥ 20 (doporučeno 22), vlastní `vitest` projektu (testováno 5.1.x), git volitelně (jen
pro `base`), binárka analyzeru (`cargo build --release` v `analyzer/`, npm balíček
`@vto/analyzer-<platforma>-<arch>`, nebo `VTO_ANALYZER=<cesta>`).

### Windows (PowerShell)

```powershell
# 1. MCP server pro projekt (v kořeni projektu):
claude mcp add --scope project --transport stdio vto -- node C:\tools\vto\mcp\bin\vto-mcp.mjs
# nebo .mcp.json v kořeni projektu:
#   {"mcpServers":{"vto":{"command":"node","args":["C:/tools/vto/mcp/bin/vto-mcp.mjs"],"timeout":3600000}}}
# 2. volitelný hook v .claude/settings.json (matcher pokrývá i nástroj PowerShell):
#   {"hooks":{"PreToolUse":[{"matcher":"Bash|PowerShell","hooks":[{"type":"command","command":"node","args":["C:/tools/vto/mcp/hooks/claude-pretooluse.mjs"]}]}]}}
# 3. první běh (nahraje mapu; nebo nechte agenta zavolat run_affected):
node C:\tools\vto\mcp\bin\vto-daemon.mjs run-affected
```

Poznámky: v `command`/`args` používejte `node <skript>` (ne npm `.cmd` shimy); IPC démona je pojmenovaná
roura `\\.\pipe\vto-<náhodné>` zveřejněná v `%LOCALAPPDATA%\vto\run\<klíč>\endpoint.json`; stromy procesů se
ukončují přes `taskkill /T /F`.

### macOS / Linux

```sh
claude mcp add --scope project --transport stdio vto -- node /opt/vto/mcp/bin/vto-mcp.mjs
node /opt/vto/mcp/bin/vto-daemon.mjs run-affected
```

Socket je v `$XDG_RUNTIME_DIR/vto/<klíč>/` (Linux) nebo `~/Library/Caches/vto/run/<klíč>/` (macOS), obojí `0700`.

### Hook

`hooks/claude-pretooluse.mjs` **jen zakáže** přesně příkazy `npx vitest [run]`, `npm [run] test`,
`pnpm [run] test`, `pnpm vitest [run]`, `yarn [run] test`, `yarn vitest [run]` (případně s holými cestami
k testům) s jednořádkovou radou použít `run_affected` / `run_tests`. Nikdy nevrací `allow`, nepřepisuje příkaz
a u všeho ostatního mlčí, takže rozhoduje běžný tok oprávnění. `VTO_HOOK=off` ho vypne.

### Typická smyčka agenta

1. úprava → `run_affected` (≤ ~100 tokenů, když je vše zelené)
2. selhání → `why_failed {test}` → oprava → `run_affected`
3. dlouhé běhy: `start_run` → `next_failures` (long-poll, seskupené) → opravovat během běhu; démon opravené
   testy přehraje ve fix lane (`fixedDuringRun`)
4. před dokončením: `run_affected {base: "origin/main"}`; s `instrumented: false` bez collectoru.

## Přehled nástrojů

Názvy, vstupy a výstupy jsou stejné jako v anglickém [README.md](README.md#tool-reference-mcp-schema-vto1);
výstupy nástrojů jsou anglicky.

## Známá omezení

- Měřeno jen na Linuxu. Cesty pro Windows/macOS (named pipe, `taskkill`, LOCALAPPDATA, délka socketu na macOS,
  detekce case-insensitive FS) jsou pokryté unit testy s mocky; CI matice (`.github/workflows/vto-ci.yml`) je
  připravená, ale ještě neběžela.
- `cpuMs` ve výsledku běhu nezahrnuje forkované workery; čísla benchmarku používají CPU celého stromu z `/proc`.
- Testy se stejným jménem na stejném řádku (`test.each` se stejným titulkem) sdílejí jeden záznam mapy (hity se sjednotí).
- Detekce změn stojí na mtime+velikosti souboru.
- `suggest_env` vidí přístup k DOM až po uživatelských setup souborech.
- Nové zdrojové soubory, které ještě žádný test neimportuje, se ignorují, dokud se nezmění jejich importér.
- Fix lane je druhý zahřátý Vitest (paměť); zavírá se po 5 minutách nečinnosti.
