# vto ui – živý terminálový pohled na běh Vitestu / live terminal UI for Vitest runs

`vto ui` (alias `vto watch`) se přihlásí k proudu událostí vto daemonu a ukazuje selhání **ve chvíli,
kdy vzniknou** – můžete je začít opravovat, zatímco běh pokračuje. Selhání opravená během běhu
(fix loop daemonu nebo `r`) zezelenají přímo v seznamu.

*English version below – [English](#english).*

## Rychlý start (s mockem)

```sh
cd tui
npm install
npm run mock          # build + interaktivní UI nad realistickým mock během (412 testů, 7 selhání)
npm run mock:big      # 10 000 testů, 500 selhání za 15 s
npm run mock:ci       # stejný běh v ne-TTY režimu (CI)
npm test              # unit + snapshot + e2e testy
npm run bench         # měření výkonu (10 000 testů + 500 selhání, ~5 400 událostí/s)
```

Proti skutečnému daemonu: `node bin/vto-ui.mjs` v kořeni projektu (nebo `--root <dir>`).
Ostatní zdroje: `--file .vto/runs/r12.jsonl` (tail -f), `--latest`, `--stdin`,
`--wait` (počká na daemon), `mock-daemon` (mock na skutečném IPC protokolu), viz `--help`.
Mock daemon týmu `mcp/` funguje také: `node ../mcp/dev/mock-events.mjs --root X` + `node bin/vto-ui.mjs --root X`.

## Obrazovky (textové záchyty, ANSI odstraněno)

Záchyty pořídil skutečný CLI běžící v pseudoterminálu, obrazovku zrekonstruoval VT emulátor
(`scripts/captures.sh`, `scripts/pty-run.py`, `scripts/screen.py`).

**Běh probíhá, selhání přibývají** (jedno už je opravené fix loopem, 120×32):

```text
 vto ui   běh r12 · dotčené · vmThreads                                                      ⠇ běží 4.7 s · zbývá ~11 s
 ███████████████████████▊░░░░░░░░░░░░░░░░░░░░░░░░  204/412   49 %  ✓ 197  ✗ 3  ↓ 4  ✔ 1 opraveno  · 3 skupin
 dom  █████▍░░░░░░░░ 101/259    node █████████▍░░░░ 103/153 ✗3
╭────────────────────────────────────────────────╮╭────────────────────────────────────────────────────────────────────╮
│ Selhání 2  · filtr: vše                        ││ Detail  ↓3                                                         │
│   ✔ formatPrice > formats thousands with a sp… ││ ✗ formatDate > formats Czech date                                  │
│ ❯ ✗ formatDate > formats Czech date  format.t… ││ src/utils/format.test.ts:16  · node                                │
│   ✗ useCart > computes totals with quantity  … ││                                                                    │
│                                                ││ Zpráva                                                             │
│                                                ││   AssertionError: expected '21. 11. 2026' to be '21. 11. 2026' //  │
│                                                ││     Object.is equality                                             │
│                                                ││                                                                    │
│                                                ││ Rozdíl                                                             │
│                                                ││   - Očekáváno                                                      │
│                                                ││   + Obdrženo                                                       │
│                                                ││   - 21. 11. 2026                                                   │
│                                                ││   + 21.␣11.␣2026                                                   │
│                                                ││                                                                    │
│                                                ││ Selhávající řádek  src/utils/format.test.ts:16:48                  │
│                                                ││   14 │ describe('formatDate', () => {                              │
│                                                ││   15 │   it('formats Czech date', () => {                          │
│                                                ││ ❯ 16 │     expect(formatDate(new Date(2026, 10, 21))).toBe('21. 1… │
│                                                ││      │                                                ^            │
│                                                ││   17 │   });                                                       │
│                                                ││   18 │ });                                                         │
│                                                ││                                                                    │
│                                                ││ Rámec v projektu  src/utils/format.ts:8:12                         │
│                                                ││    6 │                                                             │
│                                                ││    7 │ export function formatDate(d: Date): string {               │
│                                                ││ ❯  8 │   return d.toLocaleDateString('cs-CZ', { day: 'numeric', m… │
╰────────────────────────────────────────────────╯╰────────────────────────────────────────────────────────────────────╯
 ⏎ detail  o otevřít  r znovu  R znovu vše  c prompt pro AI  a do fronty  f filtr: vše  / hledat  ? nápověda  q konec
```

**Detail selhání** (Enter = celá obrazovka; zpráva, barevný rozdíl očekáváno/obdrženo, code frame
selhávajícího řádku a prvního rámce v projektu načtený z disku se zvýrazněním syntaxe, 100×40):

```text
 vto ui   běh r12 · dotčené · vmThreads                                            ✗ dokončeno 20 s
 ██████████████████████████████████████  412/412  100 %  ✓ 400  ✗ 7  ↓ 5  ✔ 1 opraveno  · 6 skupin
 dom  ██████████████ 259/259 ✗3    node ██████████████ 153/153 ✗4
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Detail  ↓3                                                                                       │
│ ✗ useCart > computes totals with quantity                                                        │
│ stále selhává  src/hooks/useCart.test.ts:8  · node                                               │
│                                                                                                  │
│ Zpráva                                                                                           │
│   AssertionError: expected { subtotal: 100, vat: 21, …(2) } to deeply equal { subtotal: 200,     │
│     vat: 42, …(2) }                                                                              │
│                                                                                                  │
│ Rozdíl                                                                                           │
│   - Očekáváno                                                                                    │
│   + Obdrženo                                                                                     │
│     {                                                                                            │
│   -   "count": 2,                                                                                │
│   -   "subtotal": 200,                                                                           │
│   -   "total": 242,                                                                              │
│   -   "vat": 42,                                                                                 │
│   +   "count": 1,                                                                                │
│   +   "subtotal": 100,                                                                           │
│   +   "total": 121,                                                                              │
│   +   "vat": 21,                                                                                 │
│     }                                                                                            │
│                                                                                                  │
│ Selhávající řádek  src/hooks/useCart.test.ts:8:35                                                │
│    6 │   it('computes totals with quantity', () => {                                             │
│    7 │     const { result } = renderHook(() => useCart([{ sku: 'A', price: 100, qty: 2 }]));     │
│ ❯  8 │     expect(result.current.totals).toEqual({ subtotal: 200, vat: 42, total: 242, count: 2… │
│      │                                   ^                                                       │
│    9 │   });                                                                                     │
│   10 │                                                                                           │
│                                                                                                  │
│ Rámec v projektu  src/hooks/useCart.ts:8:45                                                      │
│    6 │   const [items, setItems] = useState(initial);                                            │
│    7 │   const totals = useMemo(() => {                                                          │
│ ❯  8 │     const subtotal = items.reduce((s, i) => s + i.price, 0);                              │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
 o otevřít  r znovu  R znovu vše  c prompt pro AI  a do fronty  f filtr: vše  ? nápověda  q konec
```

**Opraveno během běhu** (`R` znovu spustil všechna selhání, výsledky se promítly do původního běhu):

```text
 vto ui   běh r12 · dotčené · vmThreads                                                                ✓ dokončeno 20 s
 ████████████████████████████████████████████████  412/412  100 %  ✓ 400  ✗ 7  ↓ 5  ✔ 7 opraveno  · 6 skupin
 dom  ██████████████ 259/259 ✗3    node ██████████████ 153/153 ✗4
╭────────────────────────────────────────────────╮╭────────────────────────────────────────────────────────────────────╮
│ Selhání 0  · filtr: vše                        ││ Detail  ↓5                                                         │
│   ✔ formatPrice > formats thousands with a sp… ││ ✔ formatDate > formats Czech date                                  │
│ ❯ ✔ formatDate > formats Czech date  opraveno… ││ opraveno během běhu  src/utils/format.test.ts:16  · node           │
│   ✔ useCart > computes totals with quantity  … ││                                                                    │
│   ✔ Button > disabled  opraveno během běhu     ││ Zpráva                                                             │
│   ✔ ▸ TypeError: Cannot read properties of un… ││   AssertionError: expected '21. 11. 2026' to be '21. 11. 2026' //  │
│   ✔ retry > gives up after 3 attempts  oprave… ││     Object.is equality                                             │
│                                                ││                                                                    │
│                                                ││ Rozdíl                                                             │
│                                                ││   - Očekáváno                                                      │
│                                                ││   + Obdrženo                                                       │
│                                                ││   - 21. 11. 2026                                                   │
│                                                ││   + 21.␣11.␣2026                                                   │
│                                                ││                                                                    │
│                                                ││ Selhávající řádek  src/utils/format.test.ts:16:48                  │
│                                                ││   14 │ describe('formatDate', () => {                              │
│                                                ││   15 │   it('formats Czech date', () => {                          │
│                                                ││ ❯ 16 │     expect(formatDate(new Date(2026, 10, 21))).toBe('21. 1… │
│                                                ││      │                                                ^            │
│                                                ││   17 │   });                                                       │
│                                                ││   18 │ });                                                         │
│                                                ││                                                                    │
│                                                ││ Rámec v projektu  src/utils/format.ts:8:12                         │
│                                                ││    6 │                                                             │
╰────────────────────────────────────────────────╯╰────────────────────────────────────────────────────────────────────╯
 · Znovu spouštím 6 test(ů) jako běh r13 – výsledky se promítnou sem
```

**CI / ne-TTY režim** (každé selhání hned v kompaktní podobě, opakovaná chyba jen jedním řádkem,
souhrn, exit kód):

```text
vto: běh r12 (dotčené, 412 testů, 38 souborů, pool vmThreads)
✗ src/utils/format.test.ts:5 > formatPrice > formats thousands with a space and decimal comma  #1
    AssertionError: expected '1234.50 Kč' to be '1 234,50 Kč' // Object.is equality
    at src/utils/format.test.ts:6:5
    at src/utils/format.ts:3:17  const fixed = value.toFixed(2);
    - 1 234,50 Kč
    + 1234.50 Kč
✗ src/utils/format.test.ts:15 > formatDate > formats Czech date  #2
    AssertionError: expected '21. 11. 2026' to be '21. 11. 2026' // Object.is equality
    at src/utils/format.test.ts:16:48
    at src/utils/format.ts:8:12  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
    - 21. 11. 2026
    + 21.␣11.␣2026
✗ src/hooks/useCart.test.ts:6 > useCart > computes totals with quantity  #3
    AssertionError: expected { subtotal: 100, vat: 21, …(2) } to deeply equal { subtotal: 200, vat: 42, …(2) }
    at src/hooks/useCart.test.ts:8:35
    at src/hooks/useCart.ts:8:45  const subtotal = items.reduce((s, i) => s + i.price, 0);
      {
    -   "count": 2,
    -   "subtotal": 200,
    -   "total": 242,
    -   "vat": 42,
    +   "count": 1,
    +   "subtotal": 100,
    +   "total": 121,
    +   "vat": 21,
      }
✗ stále selhává: useCart > computes totals with quantity
✔ opraveno během běhu: formatPrice > formats thousands with a space and decimal comma
✗ src/components/Button.test.tsx:13 > Button > disabled  #4
    AssertionError: expected "spy" to be called 0 times, but got 1 times
    at src/components/Button.test.tsx:17:21
    at src/components/Button.tsx:11:5  onClick?.();
    - 0
    + 1
✗ src/components/UserList.test.tsx:11 > UserList > renders empty state while loading (case 6)  #5
    TypeError: Cannot read properties of undefined (reading 'map')
    at src/components/UserList.test.tsx:12:5
    at src/components/UserList.tsx:12:13  {users.map((u) => (
✗ src/components/UserList.test.tsx:11 > UserList > renders empty state while loading  (stejná chyba v 2 testech, #5)
✗ src/api/client.test.ts:5 > retry > gives up after 3 attempts  #7
    Error: Test timed out in 5000ms.
    If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
    at src/api/client.test.ts:7:29
    at src/api/client.ts:14:30  await new Promise((r) => setTimeout(r, 2000 * i));

Souhrn: 400 prošlo, 7 selhalo, 5 přeskočeno za 20 s
✔ 1 opraveno během běhu
Skupiny chyb:
  ✔ ×1 AssertionError: expected '1234.50 Kč' to be '1 234,50 Kč' // Object.is equality  src/utils/format.test.ts:6
  ✗ ×1 AssertionError: expected '21. 11. 2026' to be '21. 11. 2026' // Object.is equality  src/utils/format.test.ts:16
  ✗ ×1 AssertionError: expected { subtotal: 100, vat: 21, …(2) } to deeply equal { subtotal: 200, vat: 42, …(2) }  src/hooks/useCart.test.ts:8
  ✗ ×1 AssertionError: expected "spy" to be called 0 times, but got 1 times  src/components/Button.test.tsx:17
  ✗ ×2 TypeError: Cannot read properties of undefined (reading 'map')  src/components/UserList.test.tsx:12
  ✗ ×1 Error: Test timed out in 5000ms.  src/api/client.test.ts:7
✗ 6 selhání zbývá
```

## Rozvržení a klávesy

- **Hlavička**: druh běhu, pool, ID běhu, spinner/čas/ETA, celkový progress bar, počty ✓ ✗ ↓ ✔ opraveno,
  počet skupin chyb, progress bar pro každý projekt (Vitest projects; přesné celkové počty pokud daemon
  pošle `run-start.projects`, jinak jen průběžné počty).
- **Seznam selhání** seskupený podle `group` (stejná chyba v N testech = jeden řádek ×N, Enter rozbalí).
  Pořadí = pořadí prvního výskytu, jen přidáváním na konec; výběr je uložen podle klíče, ne indexu
  → **nové události výběrem nehýbou**. Virtualizovaný (vykresluje se jen viditelná část).
- **Detail**: zpráva, rozdíl (zelené `-` očekáváno, červené `+` obdrženo, NBSP zviditelněné jako `␣`),
  code frame selhávajícího řádku v testu a prvního rámce v projektu (čteno z disku, invalidace podle
  mtime – oprava se projeví hned), změněné pokryté řádky, seznam testů skupiny.
- **Patička**: nápověda kláves (zkracuje se podle šířky) nebo toast s výsledkem akce.

| klávesa | akce |
|---|---|
| `↑ ↓` / `j k`, `PgUp PgDn`, `g G` | pohyb (v detailu posun) |
| `Enter` | rozbalit skupinu / detail na celou obrazovku; `Esc` zpět |
| `Tab` | fokus seznam ↔ detail |
| `o` / `O` | otevřít v editoru místo k opravě (první rámec v projektu) / selhávající řádek testu |
| `r` / `R` | znovu spustit vybranou skupinu / všechna neopravená (`rerun_failed` daemonu) |
| `c` | zkopírovat prompt pro AI (testy, chyba, diff, code frames, jak ověřit) |
| `a` | poslat skupinu do fronty úloh MCP (`enqueue_task`; daemon bez fronty → JSON úlohy do schránky) |
| `f` / `/` | filtr vše → selhané → opravené / hledání (bez ohledu na diakritiku) |
| `?` | nápověda |
| `q` | konec UI – běh v daemonu pokračuje |

### Editor (`o`)
Pořadí: `VTO_EDITOR` → `VISUAL` → (v terminálu VS Code: `code`/`cursor`/`windsurf`) → `EDITOR` →
nalezený na PATH (`code`, `cursor`, `codium`, `zed`, `webstorm`, `idea`, `subl`, pak `nvim`/`vim`/`nano`)
→ systémové otevření bez řádku. Syntaxe řádku podle editoru: VS Code rodina `-g file:line:col`,
JetBrains `--line N --column C file`, vim/nvim `+N` / `+call cursor(N,C)`, nano `+N,C`,
emacs/kak `+N:C`, helix/micro/subl/zed `file:N:C`, Notepad++ `-nN -cC`. Spouští se **bez shellu**
(argv; na Windows `.cmd` shimy přes cross-spawn s escapováním metaznaků), cesta je absolutní (nemůže
začínat `-`). Terminálové editory (vim, nano, hx, `emacs -nw`) dostanou terminál
(`suspendTerminal` Inku), po ukončení se UI obnoví.

### Schránka (`c`)
macOS `pbcopy` (vynucené UTF-8), Windows `clip.exe` (UTF-16LE s BOM – diakritika přežije) →
PowerShell `Set-Clipboard`, WSL `clip.exe`, Wayland `wl-copy`, X11 `xclip`/`xsel`, Termux; jinak (a vždy
přes SSH bez X/Wayland) **OSC 52** escape sekvence (v tmux/screen zabalená do passthrough).

## Zdroje událostí (vyměnitelná vrstva)

`src/sources/types.ts` – rozhraní `EventSource { start, request, close, canRequest }`:

- **IPC** (`ipc.ts`): protokol `vto-ipc/1` daemonu (`mcp/src/ipc.mjs`): `endpoint.json` v
  `$XDG_RUNTIME_DIR/vto | ~/.cache/vto/run | ~/Library/Caches/vto/run | %LOCALAPPDATA%\vto\run`
  `/<projectKey>/` (musí být 0600 a náš), `hello {token, protocol, client}`, `subscribe {topics:["run","test"], replay:true}`
  (coverage se neodebírá), požadavky `rerun_failed`, `enqueue_task`. Reconnect s backoffem, endpoint se
  znovu načte (restartovaný daemon = nová adresa i token). Shoda `runtimeBase/projectKey/endpointDir`
  s implementací daemonu je ověřená testem.
- **Soubor** (`file.ts`): `.vto/runs/<runId>.jsonl`, tail -f (fs.watch + stat polling pro síťové
  disky/WSL), neúplné řádky, UTF-8 rozdělené mezi čtení, zkrácení/rotace souboru.
- **stdin** (`stream.ts`): NDJSON; klávesnice se pak čte z `/dev/tty` (`CONIN$` na Windows).
- **mock** (`mock/`): deterministický realistický běh (fixture `dev/fixture` se skutečnými soubory
  → skutečné code frames), simuluje fix loop i `rerun_failed` přesně jako daemon (nový běh druhu
  `failed`); `mock-daemon` totéž přes skutečný IPC protokol.

`rerun_failed` daemonu založí **nový běh** druhu `failed`. UI ho nepřepne – výsledky promítne do
původního běhu (pass → „opraveno během běhu", fail → „stále selhává", nová chybová zpráva), pozice
v seznamu se nemění. Nový běh jiného druhu (affected/full/tests) UI převezme (`--run <id>` připne běh).

Schéma událostí podle `MCP.md` je validované tolerantně (neznámé události/pole se ignorují,
chybějící dostanou výchozí hodnoty). Volitelné rozšíření: `run-start.projects: { "<name>": { total, files } }`
→ přesné progress bary po projektech.

## CI / ne-TTY režim

Automaticky, když stdout není TTY nebo je nastaveno `CI` (nebo `--ci`/`--plain`). Každé selhání je
vypsáno hned (test, zpráva, místo v testu, první rámec v projektu se zdrojovým řádkem, zkrácený diff),
opakování stejné skupiny jedním řádkem, oprava během běhu, průběh každých 10 s, souhrn se skupinami.
Exit kód: **0** běh skončil a nic nezbývá (opravené během běhu se nepočítají), **1** zbývají selhání,
**2** zdroj skončil bez `run-end` / chyba. Barvy jen s `FORCE_COLOR`. `vto-ui --ci | head` končí tiše.

## Výkon (měřeno)

`npm run bench`: skutečná `<App>` v interaktivní (TTY) cestě Inku na falešném terminálu, mock
**10 000 testů + 500 selhání (118 skupin) za 2 s ≈ 5 400 událostí/s** (≈ 300× víc než skutečný běh
3 400 testů za 200 s), během streamování se navíc každých 60 ms tiskne klávesa. Node 22, React
production build, Linux sandbox (sdílené CPU, čísla kolísají ±50 %):

| | 120×36 | 160×48 |
|---|---|---|
| reducer (10 965 událostí) | 30–125 ms celkem (≈ 3–11 µs/událost) | 30–90 ms |
| snímků za 2 s (batch 33 ms, max 30 fps) | 34–41 | 35–39 |
| render snímku p50 / p95 | 8–12 ms / 26–60 ms | 10–14 ms / 36–130 ms |
| blokování event loopu p99 (= latence klávesy) | 40–100 ms | 55–95 ms |
| bajtů na snímek (inkrementálně / plné překreslení) | ~1,2 KB / ~4,2 KB | ~1,2 KB / ~6,2 KB |
| burst: celý běh najednou | 240–475 tis. událostí/s, 2 snímky | 73–117 tis./s |
| heap Δ / RSS | 12–30 MB / ~165 MB (bench běží pod tsx) | 6–48 MB / ~190 MB |

Skutečné CLI (`VTO_UI_PERF=1`, pty 160×48, 10 000 testů + 500 selhání za 4 s, klávesy):
render p50 **6,5 ms**, p95 **28 ms**, RSS **136 MB**; celá relace 90 KB výstupu inkrementálně vs. 755 KB
plným překreslením.

Co bylo potřeba (profilováno `--cpu-prof`):
1. **React production build** – vývojový build byl ~3× pomalejší na snímek; `bin/vto-ui.mjs`
   nastaví `NODE_ENV=production` před načtením Reactu.
2. **Jeden `<Text>` s hotovým ANSI řetězcem na řádek** (místo ~10 vnořených) a memo podle řetězce –
   nezměněné řádky React přeskočí.
3. Žádné horizontální ořezávání v Inku (řádky jsou předem zkrácené) – Ink by jinak každý řádek
   každý snímek znovu tokenizoval.
4. **Cache výstupu Inku napříč snímky** (`src/ui/inkPerf.ts`): Ink staví pro každý snímek nový
   `Output` i s cache, takže každý viditelný řádek znovu tokenizuje a rozkládá na buňky. Patch
   (s detekcí tvaru interních API, vypínač `VTO_UI_NO_INK_PATCH=1`) nechá obě cache sdílet LRU;
   42 → 17 ms/snímek při 160×48. Test ověřuje bajtově shodné snímky s patchem i bez.
5. ASCII rychlá cesta pro šířku řetězců (`string-width` používá `Intl.Segmenter`).
6. Události se aplikují v dávkách (jeden `applyMany` na chunk socketu), React se překresluje
   nejvýš jednou za 33 ms; seznam je virtualizovaný, detail se počítá jen pro vybrané selhání.

**Proč Ink**: dobře udržovaný (v8, React 19), React model sedí React/TS vývojáři, Ink 8 má
alternate screen, synchronizovaný výstup (DEC 2026 → žádné trhání), inkrementální vykreslování,
`maxFps`, `suspendTerminal` (vim) a funguje na Windows. Změřené náklady jsou po úpravách výše
v rozpočtu (≤ 33 ms/snímek i při 300× reálné zátěži), takže přechod na nízkoúrovňovou knihovnu
(blessed/terminal-kit – málo udržované, nebo vlastní renderer) by nepřinesl nic měřitelného
pro uživatele.

**Překreslování**: kde terminál prokazatelně umí synchronizovaný výstup (Windows Terminal, iTerm2,
kitty, WezTerm, Ghostty, Alacritty, foot, VS Code) se kreslí celý snímek (o ~35 % méně CPU, trhání
nehrozí), jinde (Terminal.app, starý conhost, xterm, tmux/screen) jen změněné řádky (bez blikání).
`VTO_UI_REDRAW=full|incremental` přepíše.

## Terminály a platformy

- Barvy: truecolor (hex téma) → chalk automaticky degraduje na 256/16; `COLORTERM`, `WT_SESSION`,
  `TERM_PROGRAM`, `TERM=*-256color`; `NO_COLOR` vypne barvy (tučné písmo a inverzní výběr zůstanou),
  `FORCE_COLOR=0..3` má přednost, `TERM=dumb` bez escape sekvencí.
- Unicode: box drawing a symboly jen když je terminál umí (UTF-8 locale; na Windows WT, VS Code,
  JetBrains, ConEmu/Cmder, Alacritty); jinak ASCII (`+--+`, `x`, `v`, `#`). `--ascii` / `VTO_ASCII=1`.
- Změna velikosti: rozvržení se přepočítá (≥ 110 sloupců vedle sebe, jinak pod sebou).
- UI běží v alternate screen; po ukončení se obnoví původní obsah terminálu.

Platformní výhrady (poctivě):
- **Testováno na Linuxu** (pty + VT emulátor, xterm-256color i `TERM=linux` + `NO_COLOR`). Windows
  a macOS větve (named pipe, `%LOCALAPPDATA%`, `CONIN$`, `clip.exe`, `pbcopy`, `.cmd` shimy, PATHEXT)
  jsou pokryté unit testy s injektovanou platformou, ne skutečným během na těch OS.
- Windows: legacy conhost (bez Windows Terminal) dostane ASCII a 256 barev; `--stdin` s
  interaktivním UI potřebuje `CONIN$` – když selže, použijte `--file`. Ink potřebuje Node ≥ 22.
- macOS Terminal.app neumí truecolor ani synchronizovaný výstup → 256 barev, inkrementální kreslení.
- OSC 52 musí terminál povolit (iTerm2: volba „Applications in terminal may access clipboard",
  tmux: `set -g set-clipboard on`); úspěch nejde ověřit.
- `enqueue_task` daemon (`vto-ipc/1`) zatím nemá → `a` zkopíruje úlohu jako JSON do schránky.
- `rerun_failed` daemonu je zařazen za běžící běh (Engine spouští běhy sériově) – během hlavního běhu
  výsledky dorazí až po něm; okamžitou opravu během běhu dělá fix loop daemonu po uložení souboru.

## Testy

`npm test` (vitest, 66 testů):
- `model.test.ts` – reducer událost → stav (počty, deduplikace replaye, retry, skupiny, fix-rerun,
  overlay běhů `failed`, připnutí běhu, ETA) a selektory view modelu (filtry, diakritika, stabilní výběr).
- `ui.test.tsx` – snapshoty snímků (ink-testing-library, 100 sloupců; širší přes stejný Ink s
  nastavitelnou velikostí): čekání, běh, úzké rozvržení, detail, opraveno, nápověda, ASCII; interakce
  (výběr se nehýbe při streamu, `o O r R c a f /`, read-only zdroje, fallback fronty).
- `platform.test.ts` – editory (syntaxe řádků, pořadí, PATHEXT, žádný shell), schránka (výběr nástroje,
  UTF-16LE, OSC 52/tmux, řetěz fallbacků), barvy/Unicode/překreslování, IPC discovery vs. daemon.
- `sources.test.ts` – protokol, tail-follow souboru, stdin, IPC s mock daemonem (token, replay,
  `rerun_failed`, odmítnutý token), CI výstup a exit kódy.
- `inkPerf.test.tsx` – patch Inku nemění ani bajt snímků.
- `e2e.test.ts` – skutečné CLI: CI režim s mockem (selhání vypsána dřív než konec běhu), soubor,
  stdin, `--latest`, neúplný log (exit 2), IPC s vlastním mock daemonem i s `mcp/dev/mock-events.mjs`,
  interaktivní UI v pseudoterminálu (alternate screen, synchronizovaný výstup, klávesy během běhu,
  OSC 52 se skutečným promptem, rerun → opraveno, resize, `q` → 0) a `NO_COLOR` + `TERM=linux`.

## Struktura

```
bin/vto-ui.mjs        launcher (NODE_ENV=production → dist/cli.js)
src/cli.tsx           argumenty, výběr zdroje, TUI vs CI
src/events.ts         schéma událostí, tolerantní parser, NDJSON splitter
src/model.ts          RunStore: událost → stav (mutable, O(1)/událost, version)
src/view.ts           čisté selektory: řádky, výběr, scroll, hlavička
src/ui/               Ink komponenty, řádky detailu, segmenty→ANSI, patch výkonu Inku
src/sources/          ipc / file / stream + protokol vto-ipc/1
src/mock/             scénář, in-process mock, mock daemon
src/editor.ts, clipboard.ts, proc.ts   platformní vedlejší efekty (injektovatelné)
src/prompt.ts         AI prompt a úloha pro frontu
src/ci.ts             ne-TTY výstup
src/i18n.ts           texty en/cs (výchozí angličtina, čeština přes `VTO_LANG=cs` / `--lang cs`)
dev/fixture/          malý React/TS projekt pro mock (skutečné code frames)
bench/, scripts/      měření, pty driver, VT záchyty
```

---

<a id="english"></a>
# English

`vto ui` subscribes to the vto daemon's event stream and shows failures **the moment they happen**,
so you can start fixing while the run keeps going. Failures fixed during the run (daemon fix loop or
`r`) turn green in place ("opraveno během běhu" = fixed during run). UI texts are English by default;
`--lang cs` / `VTO_LANG=cs` switches to Czech (all strings live in `src/i18n.ts`).

## Quick start

```sh
cd tui && npm install
npm run mock        # build + interactive UI on a realistic mock run
npm run mock:big    # 10 000 tests, 500 failures in 15 s
npm run mock:ci     # same run, plain CI output
npm test            # unit + snapshot + e2e
npm run bench       # performance measurement
```

Real daemon: `node bin/vto-ui.mjs` in the project root (or `--root <dir>`). Other sources:
`--file .vto/runs/<runId>.jsonl` (followed like `tail -f`), `--latest`, `--stdin`, `--wait`,
`mock-daemon` (mock on the real IPC protocol). The `mcp/` team's `dev/mock-events.mjs` works as well.
Screen captures: see the Czech section above (same program, Czech UI).

## Features
- Header: run kind, pool, run id, spinner/elapsed/ETA, overall and per-project progress bars, counters.
- Grouped failure list (same error in N tests = one row ×N, Enter expands), append-only, selection
  stored by key → **never jumps while events stream in**; virtualized.
- Details: message, coloured expected/received diff (NBSP shown as `␣`), code frames of the failing
  line in the test and of the first project frame, read from disk with light syntax highlighting
  (mtime-invalidated, so your fix shows up immediately), changed covered lines, tests of the group.
- Keys: `↑↓/jk`, `PgUp/PgDn`, `g/G`, `Enter`, `Esc`, `Tab`, `o` (place to fix) / `O` (failing test
  line), `r`/`R` rerun selected/all failed, `c` copy AI prompt, `a` queue task for MCP, `f` filter,
  `/` search (diacritics-insensitive), `?` help, `q` quit (the daemon run continues).
- Editors: `VTO_EDITOR` > `VISUAL` > VS Code terminal > `EDITOR` > PATH; per-editor line syntax
  (VS Code family, JetBrains, vim/nvim, nano, emacs, helix/micro/subl/zed, Notepad++); no shell,
  `.cmd` shims via cross-spawn; terminal editors get the terminal and the UI resumes afterwards.
- Clipboard: pbcopy / clip.exe (UTF-16LE + BOM) / PowerShell / WSL / wl-copy / xclip / xsel /
  termux, then OSC 52 (tmux/screen passthrough; preferred over SSH).
- Non-TTY / CI: every failure printed immediately (compact), repeats of a group as one line, fixes,
  progress every 10 s, summary with groups; exit 0 (nothing left), 1 (failures left), 2 (no run-end).

## Event sources and protocol
Swappable `EventSource` (IPC, file tail, stdin, mock). IPC speaks the daemon's `vto-ipc/1`
(`mcp/src/ipc.mjs`): `endpoint.json` discovery in the per-user runtime dir (0600, owner checked),
`hello {token}`, `subscribe {topics:["run","test"], replay:true}`, `rerun_failed`, `enqueue_task`;
reconnect with backoff re-reading the endpoint. A `rerun_failed` run (kind `failed`) is overlaid on the
run it re-runs instead of replacing the view. Optional schema extension: `run-start.projects`
for exact per-project bars.

## Performance
Measured with the real `<App>` in Ink's interactive path, 10 000 tests + 500 failures in 2 s
(≈ 5 400 events/s, ~300× a real run) plus a key press every 60 ms: reducer ≈ 3–11 µs/event,
frame p50 8–14 ms, p95 26–130 ms (noisy shared CPU), event-loop p99 40–100 ms, ~1.2 KB per frame
incremental; burst of the whole run: 117–475 k events/s. Real CLI in a pty (160×48):
p50 6.5 ms, p95 28 ms, RSS 136 MB. Fixes that got there: React production build, one pre-styled
`<Text>` per line, no horizontal clipping, a guarded cross-frame cache for Ink's output buffer
(42 → 17 ms/frame, byte-identical frames, kill switch `VTO_UI_NO_INK_PATCH=1`), ASCII fast path for
string width, batched events (≤ 30 fps), virtualized list.

**Why Ink**: well maintained (v8, React 19), the React model fits a React/TS developer, and Ink 8
brings alternate screen, synchronized output, incremental rendering, `maxFps`, `suspendTerminal` and
Windows support. After the fixes above it stays within a 33 ms frame budget at 300× real load, so a
lower-level library would not buy anything measurable.
Full redraw where synchronized output is known to work (Windows Terminal, iTerm2, kitty, WezTerm,
Ghostty, Alacritty, foot, VS Code), incremental elsewhere; `VTO_UI_REDRAW=full|incremental`.

## Platform caveats
- Verified on Linux (pty + VT emulator, truecolor and `TERM=linux` + `NO_COLOR`). Windows/macOS code
  paths (named pipe, `%LOCALAPPDATA%`, `CONIN$`, clip.exe, pbcopy, `.cmd` shims, PATHEXT) are
  unit-tested with an injected platform, not run on those OSes.
- Legacy conhost → ASCII + 256 colours; Terminal.app → 256 colours, incremental redraw.
- OSC 52 must be allowed by the terminal and cannot be confirmed.
- The daemon has no task queue yet (`a` copies the task JSON); `rerun_failed` is queued behind the
  running run (the daemon executes runs serially) – the instant in-run fix comes from the fix loop.
- Node ≥ 22 (Ink 8).
