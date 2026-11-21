# TODO

## Visual output of components per test (use-case gallery) – later
- Opt-in capture (`--capture`, per file/test filter) of the rendered DOM before RTL cleanup:
  HTML of the container + styles present in `<head>` (CSS-in-JS works in jsdom); helper
  `capture('label')` for several states in one test. Stored locally in `.vto/captures/`
  (gitignored; may contain test data).
- Grouped by describe/it = use cases (Storybook-like gallery without writing stories).
- VS Code extension: CodeLens "Zobrazit výstup", webview gallery per file, before/after diff.
- Caveat: jsdom/happy-dom don't render; CSS modules need `css` processing in tests or styles
  injected from the build for a faithful preview.
- Step 2: render captured HTML to PNG via Playwright (on demand, selected tests); alternative
  Vitest Browser Mode (slower, whole-suite change).
