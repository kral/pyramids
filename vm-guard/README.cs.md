# vm-guard

> **Upozornění:** `vm-guard` není publikovaný na npm a balíček `vm-guard` na npm je cizí projekt. Nespouštějte `npx vm-guard` – stáhl by a spustil cizí kód. CLI spouštějte z tohoto repozitáře: `node <cesta-k-vto>/vm-guard/bin/vm-guard.mjs`.


*English version: [README.md](README.md).*

Vrstva, díky které jdou ve Vitestu 5.1.1 bezpečně zapnout oba rychlé režimy:

| režim | Vitest | CPU na heavy podmnožině (39 souborů / 390 testů) |
|---|---|---|
| `isolated` (výchozí Vitest) | `pool: 'forks'`, `isolate: true` | 67,3 s |
| **`vm`** | `pool: 'vmThreads'` | 11,8 s (**−82 %**, overhead vrstvy +2,1 %) |
| **`shared`** | `pool: 'threads'`, `isolate: false` + `resetModules` (+ plánovač) | 5,3 s (**−92 %**), s plánovačem 5,8–6,0 s (−91 %) |

Celá heavy sada (312 souborů / 3193 testů): forks **480–498 s**, vm-guard (vm) **66 s (−86 %)**, vm-guard (shared)
**16,1 s (−97 %)**. Oba režimy mají přesně stejných 5 selhaných testů jako forks. Holý `isolate:false` jich má
308–311 (viz `vi.mock` níže).

> **Zisk závisí na projektu.** vm kontexty ušetří nastavení prostředí (jsdom) pro každý soubor a část importů.
> Samotný testový kód nezrychlí a přístup ke globálům ve vm kontextu je v horkém kódu pomalejší. Na reálném
> repu reálné sadě (validační běh, celá sada, CPU) byl vm proti forks jen **−40,8 % celkem: projekt `dom`
> −53,5 %, čistě node projekt +9,0 % (pomalejší než forks)**. shared proti dosavadnímu holému vmThreads −32,9 %.
> Pro čistě node projekty (bez jsdom/happy-dom, málo těžkých importů) zvolte `shared`, nebo nechte `forks`.
> Měřte per projekt přes `vm-guard compare --sample all` (nebo `check --compare`), viz Měření.

Všechno níže je ověřené reprodukcemi v laboratoři `vmguard-lab` (React 19, RTL 16, jsdom 31, happy-dom 21,
MSW 3, i18next 27, TanStack Query 5, better-sqlite3, Node 22, 2 sdílená jádra). Opravy existují **jen** pro
rizika, která se reprodukovala nebo je potvrzuje dokumentace/zdroják Vitestu.

## Dokumentace

Úplná dokumentace (anglicky): [../docs/vm-guard/index.md](../docs/vm-guard/index.md).

## Rychlý start

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { defineVmGuardConfig } from '@kral/vm-guard';

export default defineVmGuardConfig(
  defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  { mode: 'vm' },               // nebo 'shared'
);
```

`defineVmGuardConfig` udělá:
- vloží `@kral/vm-guard/setup` jako **první** setup file (před vaše),
- `mode: 'vm'` → `pool: 'vmThreads'` a rozumný `vmMemoryLimit` (viz Paměť); `mode: 'shared'` → `threads` + `isolate: false`,
- rozdělí běh do `projects`: soubory z `.vm-guard/incompatible.json` (pro daný režim) běží v izolovaných `forks`,
  ostatní v rychlém režimu. Projekty mají `extends: true` a nemění Vite konfiguraci, takže sdílejí jeden Vite server,
- `server.deps.inline`: doplní jen to, co předáte v `inline` (žádný balíček v labu inline nepotřeboval, viz níže),
  a varuje, když je inline jen jeden z `react` / `react-dom`,
- varuje u `test.poolOptions` (ve Vitestu 4+ odstraněno a **tiše ignorováno**, jen deprecation hláška).

Přepínání bez úpravy konfigurace: `VM_GUARD_MODE=vm|shared|isolated|off`, volby přes `VM_GUARD_OPTS='{"realm":false}'`.

### `mode: 'auto'`: DOM skupina a node skupina, každá ve svém nejlepším režimu

```ts
export default defineVmGuardConfig(config, { mode: 'auto' });
```

Zisk rychlého poolu závisí na souborech. vm kontexty šetří nastavení jsdom pro každý soubor. Čistě node soubory
z nich nic nemají a platí za pomalejší přístup ke globálům v horkém kódu. `auto` proto rozdělí sadu na dvě skupiny
a pro každou zvolí režim:

- **Směrování podle nastaveného prostředí (výchozí)**: soubor patří do skupiny `dom`, když je jeho nastavené prostředí
  (pragma `@vitest-environment`, jinak `environment` projektu nebo rootu) jsdom/happy-dom, jinak do `node`.
  Přesunout soubory s jsdom, které na DOM nesáhnou, jinam beze změny prostředí stojí 2–3× CPU (ve forks se jsdom
  staví pro každý soubor znovu) a změna prostředí mění sémantiku. Proto je to **opt-in**: `nodeEnvironment: 'node'`.
- **S `nodeEnvironment: 'node'`** se soubory DOM sady přesunou do skupiny node, která běží s `environment: 'node'`.
  Důkazy se berou od nejdůvěryhodnějšího:
  1. explicitní pragma (nikdy se nepřepisuje);
  2. zaznamenaný DOM miss (samooprava, viz níže), ten je trvalý;
  3. **naměřený** přístup k DOM z `.vm-guard/run/env.json`;
  4. **statické** signály: `.tsx`/`.jsx`; importy `@testing-library/react|dom|user-event|jest-dom`, `react-dom`,
     `jsdom`, `happy-dom`; `render(`/`renderHook(`/`screen.*`; použití `document.`/`window.`/`localStorage.` →
     dom; jinak node.
- **`.vm-guard/run/env.json`** má formát **`vto-env/1`** (vto `mcp/PROTOCOL.md` §9), společný s vto daemonem:
  `{ format, producer, updatedAt, files: { <cesta>: { group, source: 'probe'|'static', env, dom, at } } }`.
  - Vlastní sonda vm-guard (skupina dom) zapisuje `source: 'probe'`: getter pasti na DOM globály a
    **MutationObserver** na dokumentu, takže se počítají i rendery přes reference získané před sondou (RTL
    `screen`, `document.body` z importu).
  - DOM miss se ukládá jako probe záznam s `dom: true` a rozšiřujícím polem `miss: { key }`.
  - Záznamy jiných producentů zůstávají a měření nikdy nepřepíše statický záznam. Zápis je atomický (tmp +
    rename).
  - vm-guard maže jen své záznamy per worker (`.vm-guard/run/env-<pid>-<tid>.jsonl`) po jejich zapracování.
    `env.json` se nikdy nemaže a neleží v čištěném `run/logs/`.
- **Generované projekty** (bez vlastních `projects`): `dom` (vaše prostředí) a `node` (`environment: 'node'`).
  Prázdné skupiny se vynechají. U **vlastních `projects`** (podporované od `2d7ddf9`) vaše rozdělení zůstane a
  volí se jen režim projektu podle jeho prostředí. Explicitní pooly se nahradí, pokud nenastavíte
  `respectPools: true`.
- **Režim skupiny**: `autoModes` v konfiguraci (přepsání, např. `{ dom: 'vm', node: 'isolated' }`) >
  `.vm-guard/run/modes.json` > výchozí `dom → vm`, `node → shared`. `modes.json` zapisuje `vm-guard calibrate`
  (20 souborů na skupinu), `vm-guard compare --sample all` a **automaticky první `vm-guard check`** auto
  konfigurace. Každý z nich měří forks vs vm vs shared per skupina a bere nejrychlejší režim bez rozdílů ve
  výsledcích, nebo forks, když ušetří méně než 10 %. `check` na auto konfiguraci běží v režimu `auto`: každá
  skupina ve svém režimu, karanténa jde do sekce režimu skupiny souboru.
- **Samooprava** (s `nodeEnvironment: 'node'`):
  - ve skupině node hlídají pasti jen pro záznam DOM globály, které node nemá (vrací `undefined`, takže
    `typeof window` dál funguje);
  - soubor, který po sáhnutí na takový globál **selže**, nebo selže s `document is not defined`, dostane chybu
    navíc `[vm-guard] auto: … touched the DOM global 'document' but was classified as pure node …`, zaznamená se
    jako DOM miss a od dalšího běhu běží ve skupině dom;
  - detekce prostředí v knihovnách u procházejících souborů nic nepřesune;
  - soubor ze skupiny dom, který na DOM nesáhne, sonda příští běh přesune do node;
  - soubory, jejichž importy sahají na DOM už při importu (jest-dom, RTL), zůstanou v dom.

### Volby (`defineVmGuardConfig(config, volby)`)

| volba | výchozí | význam |
|---|---|---|
| `mode` | `'vm'` | `'vm'` / `'shared'` / `'auto'` (režim per skupina, viz výše) |
| `autoModes` | – | `auto`: režim per skupina/projekt, např. `{ dom: 'vm', node: 'shared' }`, má přednost před `modes.json` |
| `respectPools` | `false` | `auto` s vlastními `projects`: ponechat explicitní pooly |
| `nodeEnvironment` | `null` | `auto`: `'node'` = DOM-free soubory DOM sady přesunout do node skupiny s prostředím node (opt-in) |
| `memoryLimit` | `autoMemoryLimit()` | přepíše `vmMemoryLimit` |
| `inline` | `[]` | doplní `server.deps.inline` |
| `onDirty` | `'warn'` | špinavý stav na začátku souboru: `'warn'` / `'error'` / `'silent'` |
| `react` | `true` | duplicitní React = chyba. `'warn'` = varování, `false` = vypnuto |
| `realm` | `true` | shimy + equality tester + chybějící globály (jen vm) |
| `restoreEnv` / `reset` | `true` | obnova `process.env` / resety shared režimu |
| `resetModules` | `true` | shared: `vi.resetModules()` po každém souboru. **Nutné pro správnost `vi.mock`** (viz níže), izoluje i `src` stav. `node_modules` zůstávají v cache |
| `diag` | jen pod CLI | diagnostika (znečištění na konci souboru, residual po resetu, sken stavu `node_modules`), stojí CPU |
| `setup` | `'file'` | `'import'`: první setup soubor sám začíná `import '@kral/vm-guard/setup'` (o modul méně na soubor) |
| `alwaysProjects` | `false` | `projects` i bez karantény (jinak se nepoužívají, stojí ~4 % CPU) |
| `sharedPool` | `'threads'` | `'forks'` pro shared režim |
| `integrity` | `true` | shared: kontrola integrity `expect`/matcherů/`vi` na začátku souboru (F12) |
| `ignoreModules` | `['stylis/…']` | `node_modules` cesty se „scratch“ stavem v exportech (nehlásí se jako únik) |

Env: `VM_GUARD_MODE`, `VM_GUARD_OPTS` (JSON s volbami), `VM_GUARD_DIAG=1`, `VM_GUARD_PROFILE=1` (časy sekcí v logu),
`VM_GUARD_IGNORE_QUARANTINE=1`.

**`test.projects`** (Vitest workspace; podporováno od commitu `2d7ddf9`, ověřeno na reálná sada ve všech režimech, `verify` i `check`; nástroje, které obcházely chybějící podporu, to obcházení můžou zrušit): každý inline projekt se obalí zvlášť a **ponechá si svůj pool**:
- `vmThreads`/`vmForks` → režim vm;
- `isolate:false` → shared;
- jiný explicitní pool (`forks`, `threads`) → beze změny, jen logování;
- bez poolu → `mode` z voleb.

`VM_GUARD_MODE` přepíše všechny projekty, to používá CLI (`check`, izolované re-runy). Setup vm-guard běží v každém
projektu první, před root i projektovými `setupFiles`. Karanténa je per projekt: vznikne sourozenec
`<projekt>:isolated` ve `forks` s jen karanténními soubory daného projektu. Plánovač dělá pruhy per projekt (jeden
proces = jeden projekt). Projekty zadané cestou/globem (`'packages/*'`) a funkce se neobalují, vm-guard na ně jen
upozorní (obalte jejich konfiguraci zvlášť). Konfigurace jako funkce: zavolejte ji a předejte objekt.
Ověřeno na reálné sadě (projekty `dom` + `node`, oba vmThreads).

## CLI

```
node <path-to-vto>/vm-guard/bin/vm-guard.mjs check  [--mode vm|shared] [--prune] [filtry…]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs verify [--mode vm|shared] [--sample N|all] [--seed s]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs plan   [--lanes N] [--vto-raw <dir>]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs run    [--lanes N] [--no-heal]          # shared režim podle plánu
node <path-to-vto>/vm-guard/bin/vm-guard.mjs hunt   <soubor> [--before a,b,c]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs scan   [--quarantine]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs report
node <path-to-vto>/vm-guard/bin/vm-guard.mjs compare   [--sample N|all] [--project a,b] [--no-write]
node <path-to-vto>/vm-guard/bin/vm-guard.mjs calibrate [--sample N]
```

- **check**: spustí sadu v rychlém režimu. Padající soubory pustí znovu izolovaně ve `forks` a porovná je **po testech**.
  Test, který izolovaně projde a v rychlém režimu ne, zařadí soubor do `.vm-guard/incompatible.json` i se signaturou
  chyby (cesty a čísla jsou normalizované). V režimu `shared` nejdřív hledá viníka (hunt): najde-li ho, zapíše
  hranu do `.vm-guard/conflicts.json` místo karantény (plánovač je příště rozdělí). Před zařazením do karantény se soubor pustí v rychlém režimu ještě jednou. Když projde, hlásí se jako FLAKY (typicky timeouty pod zátěží) a do karantény nejde (`--no-confirm` krok vypne). `--prune` vrací z karantény
  soubory, které už v rychlém režimu procházejí.
- **verify**: na vzorku pustí rychlý režim i izolované `forks` a porovná stav **každého testu**. *False green*
  (projde rychle, padá izolovaně) znamená exit 5. Takový případ reálně nastává, viz „Co vrstva nepokryje“.
- **plan / run**: plánovač pro `shared` režim (viz níže). `run` je samoopravný: shared-only selhání bisektuje a zapamatuje si je.
- **hunt**: bisekce souborů, které běžely před obětí ve stejném workeru (pořadí bere z běhového logu).
- **scan**: statická analýza rizik pro `shared` režim, `--quarantine` riziková místa rovnou zakaranténuje (bez plánovače).
- **report**: nejvíc „rostoucí“ soubory podle haldy a soubory, které začaly se špinavým stavem.
- **compare** (i `check --compare`): pro každý projekt pustí vzorek (`--sample N`, výchozí 30; pro rozhodnutí
  `--sample all`) ve forks, vm a shared. Změří CPU celého stromu procesů Vitestu a spočítá testy s jiným výsledkem
  než forks. Pak doporučí režim per projekt: nejrychlejší bez rozdílů, nebo forks, když ušetří méně než 10 %.
  Výsledek je v `.vm-guard/run/compare.json`.

Exit kódy (contracts/DECISIONS.md D3): `0` OK, `1` selhání testů (skutečné, flaky i nevysvětlené), `2` špatné použití/konfigurace,
`4` změnila se karanténa/konflikty (commitněte `.vm-guard/*.json` a spusťte znovu), `5` false green ve `verify`.
`vm-guard --help` a `vm-guard <příkaz> --help` vypíší všechny volby.

Soubory:
- **commitovat** jen `.vm-guard/incompatible.json` a `.vm-guard/conflicts.json` (CODEOWNERS). Přepisují se jen
  při změně obsahu, takže `vto affected` apod. nevidí falešné změny konfigurace.
- vše proměnlivé je v `.vm-guard/run/` a **git ho ignoruje automaticky** (vm-guard tam zapíše `.gitignore` s `*`):
  logy běhů (`run/logs/`), pruhy, `durations.json`, `pollution.json`, `plan.json`, `files-cache.json`,
  `settings.json`, `verify-*.json`, `compare.json`, pro `auto` i `env.json` (důkazy klasifikace) a `modes.json` (kalibrované režimy).
- `--commit-state` nechá `durations.json` a `pollution.json` vedle commitovaných souborů (stejný plán na všech
  strojích). Proměnlivé soubory, které starší verze zapsaly přímo do `.vm-guard/`, se při dalším spuštění CLI
  přesunou do `run/` (commitněte jejich odstranění).

## Bezpečnost: vm/shared **nejsou** bezpečnostní izolace

`vmThreads` i `isolate:false` sdílejí proces, Node builtiny, `process` a (shared) i registr modulů a realm. Testový
soubor nebo závislost může pro **další soubory ve stejném workeru** podvrhnout `expect`, matchery, `vi`,
`node:*` nebo interní struktury vm-guard a ty pak projdou bez ohledu na své aserce (false green).
- **Bezpečnostně kritické brány** (CODEOWNERS testy autorizace, šifrování, audit) pouštějte v režimu `isolated`
  (`VM_GUARD_MODE=isolated`, tj. `forks` + `isolate:true`), ne jako součást rychlého běhu.
- vm-guard v shared režimu dělá **levnou kontrolu integrity**: jednou za worker si uloží identitu `expect`, jeho
  statických metod, ~30 základních matcherů (`toBe`, `toEqual`, `toThrow`, `resolves`, `not`…), funkcí `vi.*` a
  několika intrinsik (`Function.prototype.call/apply`, `Object.is`, `JSON.stringify`, `Promise.prototype.then`).
  Na začátku každého souboru je porovná. Při změně **soubor selže** (`[vm-guard] integrity: … replaced`), `check`
  ho pustí izolovaně a hunt najde viníka. `expect.extend()` s jinými názvy (jest-dom) je povolený. Vypnutí:
  `integrity: false`.
- Úložiště workeru vm-guard je nepřepisovatelná, nekonfigurovatelná vlastnost (`Symbol`) na `process`. Jeho
  obsah ale test změnit může. Kontrola integrity je pojistka proti nehodám a hloupým útokům, ne proti cílenému
  útočníkovi s možností spustit kód v testu.
- **Data v `.vm-guard/`** (commitovaná) se validují (F9): do `include` a plánů projdou jen doslovné, normalizované
  relativní cesty existujících souborů uvnitř repa (žádné `..`, absolutní cesty, glob znaky, symlinky ven), které
  odpovídají `include` a ne `exclude` daného projektu a které Vitest sám vylistuje. Ostatní se ignorují s varováním.
  Totéž platí pro `VM_GUARD_LANE_FILE`, `conflicts.json`, `pollution.json`, `durations.json` a `hunt --before`.
  Doporučení: CODEOWNERS na `.vm-guard/`.
- **Dočasné soubory** (F8): JSON reporty Vitestu jdou do nového privátního adresáře `mkdtemp` (0700, nepředvídatelné
  jméno). Čtou se bez následování symlinků (`O_NOFOLLOW`) a jen tehdy, když adresář i soubor patří aktuálnímu
  uživateli, adresář je 0700 a soubor má jediný hardlink. Po běhu se adresář smaže.

Regresní testy PoC: `test/security.test.mjs` (PoC 8: podvržené symlinky na staré předvídatelné cesty, PoC 9:
`scripts/release-helper.mjs` v `incompatible.json`, F12: podvržený `toBe` → další soubor selže, kontrolní běh bez
kontroly ukáže false green).

## Rizika režimu `vm` (vmThreads)

Princip: každý testovací soubor má vlastní `vm` kontext. Kód z `node_modules` se v něm vyhodnocuje znovu
(vlastní CJS/ESM executor), takže singletony knihoven jsou per-soubor. **Sdílený zůstává jen vnější realm workeru**:
Node builtiny (`fs`, `util`, `http`…), `process`, nativní addony a globály, které prostředí zkopíruje z Node
(`structuredClone`, `fetch`/`Response`, `Buffer`, `AbortController`, `MessageChannel`…).

| riziko | reprodukováno? | mitigace ve vm-guard | zbytkové riziko |
|---|---|---|---|
| cross-realm `instanceof` / `toBeInstanceOf` / `toThrow(Error)` / `toStrictEqual` u objektů z builtinů a zkopírovaných globálů (chyby z `fs`, `fs/promises` a `util.promisify` Promise, `readdirSync` pole, `structuredClone`, `Response.json()`, `arrayBuffer`, chyby `fetch`, data z `MessageChannel`) | **ano**: jsdom 21/53, happy-dom 28/53 kontrol padá jen ve vm. Totéž se projeví i v kódu komponent (`data instanceof Array` větví jinak) | `Symbol.hasInstance` shimy na intrinsických konstruktorech kontextu (Array, Object, Error + 7 podtříd, Map, Set, Weak*, Promise, Date, RegExp, ArrayBuffer, DataView, typed arrays). Přijímají **jen** stejný konstruktor vnějšího realmu, uživatelské podtřídy (`class MyErr extends Error`) mají normální sémantiku. Plus equality tester, který cizí objekt mělce převede do realmu kontextu a zachová `toStrictEqual` striktní | kontroly přes `x.constructor === Array` nebo `Object.getPrototypeOf(x) === Array.prototype` v uživatelském kódu shim neopraví. Po mitigaci zbyly jen selhání, která padají i ve forks |
| objekty vytvořené kódem z `node_modules` (Error, Map, Uint8Array, Promise) | **ne**, `node_modules` běží uvnitř kontextu | – | – |
| chybějící Web globály ve vm kontextu (jsdom: `ReadableStream`, `WritableStream`, `TransformStream`, `*Stream`, `CompressionStream`, `CryptoKey`, `SubtleCrypto`, `crypto.subtle`; happy-dom: `BroadcastChannel`, `MessageChannel`/`Port`, `CompressionStream`, `TextEncoderStream`, `CryptoKey`) | **ano**: **MSW padá už při importu** (`WritableStream is not defined` / `BroadcastChannel is not defined`), `crypto.subtle.digest` padá | chybějící globály se doplní z vnějšího realmu | jsou z vnějšího realmu, jejich výstupy řeší shimy. MSW + happy-dom nefunguje ani ve forks (problém happy-dom) |
| duplicitní React / „Invalid hook call“ | **ne**: `server.deps.inline` pro react / react-dom / RTL / obojí ani `deps.optimizer` s částečným include duplikát nevytvořily (forks ani vm) | detektor: realpath `react` z rootu i z deklarovaných React knihoven (react-dom, RTL, MUI…). Při více kopiích hned na startu jasná chyba (`react: 'warn'` z ní udělá varování). Konfigurace varuje při inline jen jednoho z react/react-dom | detekuje fyzické kopie na disku, ne duplikát vzniklý transformací |
| stav mezi soubory přes `node_modules` singletony (i18next, QueryClient/focus/onlineManager, modulový store v balíčku) | **ne**: ve vm je stav per-soubor (stejně jako forks) | – (leak detektor se ve vm na `node_modules` nedívá, není proč) | – |
| stav mezi soubory přes **vnější realm**: `process.env` (i `vi.stubEnv` bez unstub), `process.on` listenery, singleton uložený na `process` (vzor signal-exit/APM), monkeypatch `node:http` | **ano**: ve forks čisté, ve vm unikne do dalšího souboru | leak detektor (otisk `process.env`, listenerů, vlastností `process`, identit exportů builtinů) na začátku každého souboru varuje s názvem předchozího souboru. `process.env` se po každém souboru **obnoví** (+ `vi.unstubAllEnvs`) | listenery a patche builtinů se jen hlásí. `check` zakaranténuje oběť (viníka najdete v logu `dirty`) |
| paměť: `vmMemoryLimit` | **ano, potvrzeno ve zdrojáku**: limit se porovnává s `heapUsed` po každém souboru. Výchozí je `totalmem / maxWorkers`, tady 7,7 GB při halda-limitu workeru 8,2 GB, takže prakticky nikdy nezabere. `poolOptions.vmThreads.memoryLimit` je ignorováno | `autoMemoryLimit = min(50 % RAM / workers, 60 % V8 heap limit)`, min. 512 MB. Měření haldy per soubor, `report` ukáže nejvíc rostoucí soubory | 120 běžných souborů: halda drží ~330 MB, bez růstu (Vitest 5 čistí kontexty). Únik do vnějšího realmu roste lineárně (1,1 GB / 120 souborů). Limit 300 MB to sice usekne, ale 7 recyklací stojí **+44 % CPU**, proto limit nesmí být malý |
| nativní addony (better-sqlite3) | funguje, ale vrací objekty vnějšího realmu (pole, chyby, Buffer) | shimy | – |
| `require.cache` (smazat + re-require), `Module.prototype.require` / `Module._load` hooky (require-in-the-middle, OpenTelemetry, pirates), `process.chdir` | **ano**: nefresh modul, hook hází `TypeError`, `_load` neexistuje, `chdir` „not supported in workers“ (i v `threads`). `server.deps.inline` nepomůže | nelze opravit ve vrstvě, `check` je pošle do karantény (forks) | – |
| fetch + AbortController, `AbortSignal.timeout`, `addEventListener({signal})`, FormData/Blob | abort funguje. `instanceof DOMException` padá i ve forks (jsdom). Zbytek je cross-realm (viz výše) | shimy | – |
| fake timers (setTimeout v komponentě, `setSystemTime`, Date v `node_modules`, `performance`, `setImmediate`, `queueMicrotask`, `runAllTimersAsync`, RTL `waitFor`) | **ne**, žádný rozdíl vm vs forks. `toFake: ['nextTick']` funguje jen v thread poolech | – | – |

## Rizika režimu `shared` (`isolate: false`)

Jeden worker pouští soubory za sebou ve stejném realmu a se stejným registrem modulů. Fixture: 17 dvojic
znečišťovatel/oběť + 16 neutrálních souborů. Nejhorší pořadí (1 worker, znečišťovatelé před obětmi) bez
vm-guard: **12 obětí padá**.

| riziko | reprodukováno? | mitigace | zbytkové |
|---|---|---|---|
| stav na úrovni modulu v `src` (`let count`) | **ano** | `resetModules` (výchozí) **nebo**, při `resetModules: false`, plánovač: měkká hrana mezi soubory, které sdílejí stavový modul (heuristika `let`/mutovaná kolekce na top-levelu; moduly z vto `fileload` dat nebo z importů testu), plus historie | stav uvnitř closure detektor nevidí, chytí ho až samooprava |
| singletony v `node_modules` (i18next init, react-query online/focusManager) | **ano** | sondy (i18next, query-core přes `vi.importActual`). query-core se resetuje, i18next se hlásí jako *residual*, takže vzniká **tvrdá hrana** na soubory, které i18next importují. Auto-detekce stavu CJS exportů všech načtených balíčků (primitiva + velikosti kolekcí) | balíčky bez sondy, jejichž stav není vidět v exportech |
| `vi.mock` modulu ze `src` importovaného **přímo** testem (i různé factory), `vi.doMock` | ne (Vitest invaliduje samotný mockovaný modul) | konzervativně tvrdá hrana mezi soubory s různou factory | – |
| **`vi.mock` modulu ze `src` importovaného tranzitivně** (test → komponenta → `api/client`) | **ano, obousměrně**: komponenta v cache si drží tu vazbu (reálnou nebo mock), kterou dostala jako první. Na celé heavy sadě (312 souborů) **309 selhaných testů** v 35 souborech s `vi.mock`, resety bez `resetModules` nepomohou (312) | **`resetModules: true` je výchozí** v shared režimu → plná sada má stejných 5 selhání jako forks. Při `resetModules: false` (`run --no-reset-modules`) přidá plánovač tvrdé hrany: soubor mockující M ↔ každý soubor, který M importuje bez mocku, nebo ho dosáhne přes jiný projektový modul. **I stejně napsaný `vi.mock` konfliktuje**: každý soubor má vlastní instance `vi.fn()` a komponenta v cache volá ty z prvního souboru. Heavy: 780 hran, 39 souborů do forks | při `resetModules: false` jen statický graf (dynamické importy, aliasy nevidí) |
| `vi.mock('balíček')` z `node_modules` | **ano** | statická hrana: mockující soubor ↔ soubory, které balíček importují (i přes zdrojové moduly) | – |
| neobnovené mocky: `vi.spyOn` | **ne** | – | – |
| neobnovené mocky: přímé přiřazení (`Date.now = vi.fn()`, `console.warn = vi.fn()`) | **ano** | snapshot ~40 sledovaných globálů (Date, Math.random, console.*, fetch, timery, matchMedia, observery, innerWidth…) a jejich obnovení | přiřazení do jiných globálů jen hlásí `scan` (`global-assign`) |
| `vi.stubGlobal` / `vi.stubEnv` bez unstub | **ano** | `vi.unstubAllGlobals()`, `vi.unstubAllEnvs()` a obnovení `process.env` | – |
| zapnuté fake timers | **ano** (oběť visí do timeoutu) | `vi.useRealTimers()` | – |
| DOM zbytky (`body`, `head`, `title`, atributy `<html>`/`<body>`) | **ano** | vyčištění + odebrání uzlů `head`, které nejsou v baseline | – |
| listenery na `window`/`document` | **ano** | instrumentace `add/removeEventListener` a odebrání listenerů, které **nezaregistroval kód z `node_modules`** (knihovny registrované jednou při importu zůstávají) | listener knihovny přidaný kvůli testu zůstane |
| `localStorage` / `sessionStorage` | **ano** | `clear()` | – |
| neodmontované React roots (`createRoot` bez `unmount`) | **ano** (interval dál mění `document.title`) | obalení `react-dom/client.createRoot`, odmontování v `act()` | – |
| RTL cleanup | v labu je `cleanup` v setupu, samostatně se neprojevil | (váš setup) | – |
| top-level side effects v testech | statická detekce (`scan`) | `scan --quarantine` nebo pořadí „polluter na konec“ | – |

Výsledek na fixture: samotné resety snížily selhání z 12 na 2 (i18next, `src` stav). Plánovač se samoopravou je dostal na **0**, viz Měření.

> **Poučení z plné sady:** fixture ani 39souborová podmnožina tranzitivní `vi.mock` neobsahovaly, proto se problém
> ukázal až na 312 souborech. Bez `resetModules` je shared režim pro sady s `vi.mock` **nebezpečný**. Proto je reset
> výchozí a vypnout ho má smysl jen se `verify --mode shared` na celé sadě.

### Plánovač (shared)

1. **Graf konfliktů**: tvrdé hrany z historie (`conflicts.json`, zapisuje hunt), z `vi.mock('balíček')` proti importům
   balíčku, z různých factory pro stejný modul a ze *residual* znečištění singletonu (co přežilo resety) proti
   importérům. Měkké hrany ze sdílených stavových modulů. Moduly per testovací soubor bere z vto `fileload.modules`
   (`--vto-raw <dir>`, FORMAT.md v2), jinak z importů testu.
2. **Rozdělení**: hladové barvení (LPT podle délky z `durations.json`, případně z vto `durationMs`) do `--lanes`
   pruhů (výchozí `cores-1`). Tvrdý konflikt nesmí být ve stejném pruhu, měkký stojí 25 % ideální zátěže pruhu.
   Co se nikam nevejde, jde do izolovaného koše (forks).
3. **Pořadí v pruhu**: známé oběti první, znečišťovatelé (statické rysy, naměřené znečištění, historie) poslední.
4. **Realizace ve Vitestu 5.1.1** (ověřeno ve zdrojáku `groupSpecs` / `pool.run`): s `isolate:false` a `maxWorkers:1`
   Vitest pošle **všechny soubory projektu jedním run requestem do jednoho workeru** v pořadí sequenceru. S
   `maxWorkers>1` se worker znovu použije jen tehdy, když je další úloha ve frontě ze stejného projektu, a soubory
   si workery berou dynamicky. Několik projektů s `maxWorkers:1` musí mít různé `sequence.groupOrder`, takže běží
   **sériově**. Přiřazení souboru k workeru proto v jednom procesu řídit nejde. `vm-guard run` pouští **každý pruh
   jako samostatný proces Vitestu** (`VM_GUARD_LANE_FILE` → přesný `include`, `maxWorkers: 1`, `VmGuardSequencer`)
   a izolovaný koš jako další proces.
5. **Samooprava**: soubor, který ve shared padá a izolovaně projde, se bisektuje proti souborům, které před ním
   běžely ve stejném workeru (log `.vm-guard/run/w-*.jsonl`). Stojí to ~log2(n)+2 běhů, na fixture 9–10. Dvojice
   jde do `conflicts.json` a další plán ji rozdělí.

## Měření

### `mode: 'auto'` (reálná sada a heavy, celé sady, CPU s)

Kopie v labu, originál reálná sada zůstal nedotčený. „současné“ = vlastní konfigurace repa (reálná sada:
projekty `dom` + `node`, oba vmThreads; heavy: výchozí forks).

| repo | varianta | CPU s | vs současné | vs forks | selhané testy |
|---|---|---|---|---|---|
| reálná sada (1992 testů) | současné (vmThreads + vmThreads) | 168,6 / 174,8 | – | −42 % | 0 |
| | forks (vše izolovaně) | 297,1 | +73 % | – | 0 |
| | vše vm (vm-guard) | 178,3 | +4 % | −40 % | 1 (timeout pod zátěží) |
| | vše shared (vm-guard) | 119,2 | −30 % | −60 % | 0 |
| | **auto, výchozí** (dom → vm, node → shared) | **143,5** | **−15 %** | −52 % | 0 |
| | `calibrate` (jednorázově, 20 souborů na projekt) | 80,4 | | | |
| | **auto, kalibrované** (`modes.json`: dom → shared, node → shared) | **114,3 / 120,5 / 112,1** | **−34 %** | **−62 %** | 0 (stejně jako forks a současné: žádné) |
| heavy (3193 testů) | současné (forks) | 480 / 498 | – | – | 5 (předem existující) |
| | **auto, výchozí** (všech 312 souborů dom → vm) | **74,4** | −85 % | −85 % | 5 |
| | `calibrate` | 44,6 | | | |
| | **auto, kalibrované** (dom → shared) | **17,6 / 17,1** | **−96 %** | −96 % | 5: seznam selhaných testů shodný s forks (porovnáno diffem) |
| | první `vm-guard check` (sám kalibruje, pak kontroluje v režimu auto) | 67,2 | | | 5, tytéž 3 předem existující soubory |

Jak to číst: na obou repech vyšel jako nejlepší režim obou skupin `shared`. Kalibrované `auto` se tu proto rovná
nejlepšímu jednotnému režimu (vše shared) v rámci šumu a nepřekoná ho. Výchozí nastavení bez kalibrace už na
reálná sada porazí vlastní setup repa (−15 %), protože node projekt opustí vmThreads (tam +9–10 % proti forks).
`auto` se vyplatí, když se skupiny liší (DOM-těžké UI vedle CPU-těžké čisté logiky), a jako bezpečný výchozí stav,
který `calibrate` zpřesní. Kalibrace stojí na vzorku: když vybere `shared`, potvrďte to přes
`verify --mode shared --sample all` (nightly), než se na něj spolehnete.


Stroj: 2 sdílená jádra (load 3–8), měří se **CPU čas** (user+sys celého stromu procesů, bash `time`). Wall je
zkreslený. Heavy = kopie `perf-lab/heavy` (MUI + emotion + RTL, jsdom), podmnožina `.1.test` = 39 souborů / 390 testů,
všechny varianty 390/390 zelené. Mediány, forks n=3, ostatní n=6, prokládaně.

| varianta | CPU s | vs forks | overhead vrstvy |
|---|---|---|---|
| forks (výchozí) | 67,3 | – | – |
| vmThreads holý | 11,56 | −82,8 % | – |
| **vm-guard (vm)** | **11,80** | **−82,5 %** | **+2,1 %** (párový medián; průměr +2,9 %) |
| vm-guard, setup přes `import 'vm-guard/setup'` | 11,75 | −82,5 % | +2,6 % |
| vm-guard s 1 souborem v karanténě | 13,0–13,6 | −80 % | (= cena 1 souboru ve forks, ~1,7 s) |
| threads + isolate:false holý | 5,15 | −92,3 % | – |
| **vm-guard (shared, resety + detekce)** | **5,33** | **−92,1 %** | +3,5 % (párový medián +5 %) |
| `vm-guard run` (plán, 1 pruh, bez diagnostiky) | 5,78 | −91,4 % | +12 % (druhý proces, fixní ~0,6 s) |
| `vm-guard run` (plán + diagnostika + samooprava) | 6,02 | −91,1 % | +17 % |

Vlastní čas vrstvy (`vm-guard report`, wall, tedy horní odhad): vm 3,8 ms/soubor, shared 6 ms/soubor, s diagnostikou
17 ms/soubor. Co pomohlo ze stavu v0 (vm +3,3 %, shared +16 %, plán +34 %): bez `projects`, když není karanténa
(samotný 1 inline projekt stál ~4 %), outer-realm otisk kompilovaný jednou na worker (vm pool vypíná compilation
cache a setup modul se kompiluje znovu pro každý soubor), inkrementální sken stavu `node_modules`, diagnostika jen
pod CLI (`VM_GUARD_DIAG=1`), cache `vitest list`. Samotný prázdný setup soubor navíc stojí ve vmThreads ~2–3 %.
Proto je setup jeden bundlovaný modul.

### Celá heavy sada (312 souborů / 3193 testů)

CPU s. Forks n=2, ostatní n=2 (prokládaně), stroj klidnější. „Selhání“ = selhané testy. Forks má 5 předem
existujících selhání (3 soubory se `souběžně` testy) a ve všech řádcích s 5 selháními jde o **identický seznam
testů**.

| varianta | CPU s | vs forks | selhání |
|---|---|---|---|
| forks | 480 / 498 | – | 5 |
| vmThreads holý | 64,6 / 64,3 | −87 % | 5 |
| **vm-guard (vm)** | **67,2 / 65,6** | **−86 %** | **5** (overhead +2,0 až +4,0 %, průměr +3,0 %) |
| threads + isolate:false holý | 29,8 / 29,3 | (−94 %) | **308–311** |
| vm-guard shared **bez** `resetModules` | 31,9 | – | **308** |
| **vm-guard shared (výchozí, `resetModules`)** | **16,1 / 16,1** | **−96,7 %** | **5** |
| `vm-guard run` (plán, bez diagnostiky) | 18,0 / 18,1 | −96,3 % | 5 |
| `vm-guard run --no-reset-modules` (780 mock hran → 39 souborů do forks) | 83,9 | −83 % | 5 |
| `vm-guard check --mode shared` (plán + diagnostika + izolovaný re-run 3 souborů) | 24,4–25,5 | – | 5 (exit 1 = předem existující) |

Shared s `resetModules` je dokonce rychlejší než holý `isolate:false`, protože ten tráví čas v timeoutech
padajících `findBy*`. Reset `src` modulů je levný, drahé `node_modules` (MUI, emotion, react-dom) zůstávají v cache.

Fixture shared režimu (48 souborů, 17 dvojic, 12 se reálně projeví; měřeno ještě bez výchozího `resetModules`):

| varianta | CPU s | padající oběti |
|---|---|---|
| izolované forks | 42–43 | 0 |
| threads + isolate:false, 2 workery, výchozí pořadí | 2,7 | 3–6 (nedeterministicky, přiřazení k workerům je dynamické) |
| threads + isolate:false, 1 worker, nejhorší pořadí | 2,1 | **12** |
| + vm-guard resety | 2,5 | 2 (i18next, `src` stav) |
| + `resetModules` (dnes výchozí) | – | 1 (i18next) |
| `vm-guard run`, 1 pruh, studený start | – | 2 → samooprava (9 a 10 běhů bisekce) → **0**, 0 |
| `vm-guard run`, 2 pruhy, studený start | 4,7 | 1 → samooprava (9 běhů) → **0**, 0 |
| vm-guard (vm), nejhorší pořadí | – | 0 (holý vmThreads: 1, `vi.stubEnv` přes `process.env`) |

Zabráněno: resety 10/12, plán se samoopravou 12/12 od druhého běhu. i18next pár by plán rozdělil i bez bisekce,
protože *residual* znečištění singletonu z prvního běhu vytvoří tvrdou hranu.

Paměť (`mem/`, 120 souborů, 1 worker, vmThreads): výchozí limit nikdy nerecykluje, špička ~330 MB. Únik na
`process`: 1,1 GB. `vmMemoryLimit: 300MB` dělá 7 recyklací a stojí +44 % CPU (15,6 → 22,6 s).
`poolOptions.vmThreads.memoryLimit` je ignorováno.

## Co vrstva nepokryje

- **False green proti forks**: shimy dělají vm *tolerantnější* než forks + jsdom, protože jsdom ve forks má vlastní
  realm a `Buffer.from() instanceof Uint8Array` tam padá. Test, který projde ve vm a ve forks padá, odhalí jen
  `verify`. Proto nightly forks.
- Kontroly přes `constructor ===` nebo prototyp, `Object.prototype.toString` triky v uživatelském kódu.
- require hooky, `require.cache`, `process.chdir`, cokoli s `Module._load` → jen karanténa.
- Ve vm: listenery na `process`, patche builtinů a singletony na `process` se jen hlásí, neobnovují se.
- Ve shared: stav v closure balíčků z `node_modules` bez sondy, které nejsou vidět v exportech (`resetModules`
  resetuje jen projektové moduly). To chytí jen samooprava: první běh selže.
- Ve shared s `resetModules: false` jsou `vi.mock` hrany jen ze statického grafu importů.
- Detektor stavu `node_modules` nerozliší „scratch“ stav parseru od úniku. stylis je ve výchozím ignore listu,
  další doplňte do `ignoreModules`.
- Detektor duplicitního Reactu vidí jen fyzické kopie.
- Plánovač s 1 pruhem (2 jádra → `cores-1 = 1`) posílá konfliktní soubory do izolovaného koše. Víc pruhů = míň izolace.

## Doporučený rollout

0. `node <path-to-vto>/vm-guard/bin/vm-guard.mjs compare --sample all`: výběr režimu per projekt (vm pro DOM projekty, shared nebo forks pro
   čistě node).
1. **Ověření**: `VM_GUARD_MODE=vm node <path-to-vto>/vm-guard/bin/vm-guard.mjs verify --sample all` lokálně, projít false green / false red.
2. **check → karanténa**: `node <path-to-vto>/vm-guard/bin/vm-guard.mjs check --mode vm` a commit `.vm-guard/incompatible.json`.
   Opakovat, dokud exit není 0/1. Karanténní soubory poběží ve forks automaticky.
3. **PR pipeline**: běžný `vitest run` s `defineVmGuardConfig` (vm + karanténa ve forks). Exit 4 z `check`
   na PR = někdo přidal vm-nekompatibilní test, commitnout aktualizaci karantény.
4. **Nightly forks**: `VM_GUARD_MODE=isolated vitest run` (celá sada izolovaně) + `node <path-to-vto>/vm-guard/bin/vm-guard.mjs verify --sample 500`
   (exit 5 = false green) + `node <path-to-vto>/vm-guard/bin/vm-guard.mjs check --prune` (uvolní opravené soubory).
5. **Shared až potom**, volitelně pro lokální/pre-push běhy: `node <path-to-vto>/vm-guard/bin/vm-guard.mjs scan`, pak `node <path-to-vto>/vm-guard/bin/vm-guard.mjs run`
   (plán + samooprava). Commitovat `conflicts.json`. Nightly
   `verify --mode shared`.

### Který režim jako výchozí

**Per projekt**: jednou pusťte `vm-guard compare --sample all`. Projekty s jsdom/happy-dom ve vm obvykle získají
nejvíc. Čistě node projekty často nic nezískají nebo se zpomalí (reálná sada `node`: +9,0 %), tam použijte
`shared` (s `resetModules`), nebo nechte `forks`. U `projects` nastavte pool per projekt, vm-guard ho ponechá.

**Výchozí bod**: `mode: 'auto'` (dom → vm, node → shared), pak `vm-guard calibrate` a čistý nightly
`verify --mode shared --sample all`, než se spolehnete na kalibrované `shared`.

**Doporučení: `mode: 'vm'` jako výchozí v CI, `mode: 'shared'` (s výchozím `resetModules`) pro lokální a pre-push
běhy a do CI ho povýšit, až bude nightly `verify --mode shared` na celé sadě nějakou dobu čistý.**
- vm drží izolaci modulového grafu včetně `node_modules` per soubor. Stav knihoven, `vi.mock` ani DOM mezi soubory
  neprotékají z principu, ne díky heuristikám. Vrstva stojí ~2–4 %. Na celé sadě: −86 %, 0 nových selhání.
- shared je na celé sadě 4× rychlejší než vm (16 s vs 66 s CPU, −97 % vs forks) a také s 0 novými selháními. Jeho
  správnost ale stojí na resetech a heuristikách: bez `resetModules` byl **nebezpečný** (308 selhání kvůli
  tranzitivním `vi.mock`), a to se neprojevilo na 39souborové podmnožině ani na fixture, jen na plné sadě. Stav v
  closure modulů `node_modules` (singletony bez sondy) se pozná až selháním a samoopravou. Proto shared jen s
  `verify --mode shared --sample all` v nightly.

## Lab

Reprodukce, fixture a skripty: `/home/claude/vmguard-lab` (`repro/*`, `shared/`, `mem/`, `heavy/`, `scripts/run.mjs` =
matice forks × vmThreads × jsdom/happy-dom). Testy vrstvy: `npm test` (`test/unit.test.mjs`, `test/security.test.mjs`; potřebuje nainstalovaný `vitest`, bez něj se integrační testy přeskočí). Anglická verze: [README.md](README.md).
