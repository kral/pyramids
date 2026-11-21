# pyramids – vto (Vitest test overlap)

Fast detection of unnecessarily overlapping Vitest tests (React components / hooks in TS/TSX)
and test impact analysis (`vto affected`). **Work in progress.**

- `collector/` – Vite plugin that instruments only project files (`plugin.mjs`, oxc-parser +
  magic-string) and setup that records per-test hits; V8 fallback (`setup.ts`).
  Runner: `node collector/run-raw.mjs <rawDir> [--engine v2|v8] [vitest args]`.
- `analyzer/` – Rust CLI `vto` (report.md in English by default, `--lang cs` / `VTO_LANG=cs` for Czech; language-independent report.json; `vto affected`, `vto pack`).
  `cargo build --release` → `analyzer/target/release/vto <rawDir> --out overlap-report`.
- `collector/corpus/` – differential test corpus of tricky TS/TSX for the instrumenter.
- `bench/` – benchmark fixture generator.
- `FORMAT.md` – raw data contract, `REVIEW-1.md` – first independent critical review.
- `vitest-overlap.mjs` – user entrypoint (collector + analyzer).
