// vitest-guard: LAST setup file in shared mode (added by defineVitestGuardConfig together with sequence.setupFiles 'list').
// It marks "all setup files of this test file have run": what exists now on built-in prototypes / in the matcher
// registry belongs to the setup files; whatever appears later was added by the test file itself and must not
// reach the next file in the shared worker (REVIEW-2-correctness M6). No imports: one tiny module per file.
const w = process[Symbol.for('vitest-guard.worker')];
if (w && typeof w.afterSetup === 'function') await w.afterSetup();
