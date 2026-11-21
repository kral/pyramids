// plain project config (no vto) – used for the full-suite runs of the fault-injection check
export default { test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] }, oxc: { jsx: { runtime: 'automatic' } } };
