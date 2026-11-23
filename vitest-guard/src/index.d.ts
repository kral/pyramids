import type { ViteUserConfig } from 'vitest/config';
export interface VitestGuardOptions {
  /**
   * 'vm' = pool vmThreads (default), 'shared' = threads + isolate:false, 'auto' = per group/project (see autoModes),
   * 'isolated' = plain forks with isolation (guard layer only, no speed-up).
   * Env VITEST_GUARD_MODE=vm|shared|auto|isolated|off overrides; 'off' returns your config untouched (env only, not a config value).
   */
  mode?: 'vm' | 'shared' | 'auto' | 'isolated';
  /** mode 'auto': per group/project mode override, e.g. { dom: 'vm', node: 'shared' } ('vm' | 'shared' | 'isolated') */
  autoModes?: Record<string, 'vm' | 'shared' | 'isolated'>;
  /** mode 'auto' with user projects: keep explicit project pools */
  respectPools?: boolean;
  /** mode 'auto': 'node' = files of a DOM-configured suite that never touch the DOM (measured, else static) move to the node group with environment node (opt-in; default routes by the configured environment) */
  nodeEnvironment?: 'node' | null;
  /** bytes or Vitest string ('1.5GB', '30%'); default autoMemoryLimit(maxWorkers) */
  memoryLimit?: number | string;
  /** extra server.deps.inline entries */
  inline?: (string | RegExp)[];
  /** what to do when a file starts with dirty state: default 'warn' */
  onDirty?: 'warn' | 'error' | 'silent';
  /** duplicate React check: true = throw (default), 'warn', false */
  react?: boolean | 'warn';
  /** extra packages (besides the built-in list: react-dom, @testing-library/react, @tanstack/react-query, ...) whose own `react` copy the duplicate-React check compares with the root's */
  reactPackages?: string[];
  /** realm shims in vm mode (default true) */
  realm?: boolean;
  /** shared mode: probes that detect leaked state between files (default true) */
  probes?: boolean;
  /** restore process.env after each file (default true) */
  restoreEnv?: boolean;
  /** reset hooks between files (default true) */
  reset?: boolean;
  /** write run logs to .vitest-guard/run/logs (default true) */
  log?: boolean;
  /** shared mode: integrity check of the assertion API (expect/matchers) between files (default true) */
  integrity?: boolean;
  /** shared mode: the tail setup file that marks the end of the setup files, where the baseline is taken (default true; setupFiles run in list order). `false` with shared mode is a config error */
  tail?: boolean;
  /** shared mode: print a warning when no clean `vitest-guard verify --mode shared` is recorded for this commit/config (default true). Also VITEST_GUARD_VERIFY_WARNING=0. */
  verifyWarning?: boolean;
  /** shared mode: vi.resetModules() after every file (default true). Without it a module that a cached
   *  importer loaded first keeps that binding: vi.mock of a transitively imported module silently stops applying. */
  resetModules?: boolean;
  /** diagnostics (pollution diff at file end, residual after reset, node_modules export-state scan); default: on only under the vitest-guard CLI (VITEST_GUARD_DIAG=1) */
  diag?: boolean; moduleState?: boolean; detectPollution?: boolean;
  /** process event names (e.g. 'SIGINT') whose added listeners are not reported as a leak */
  ignoreListeners?: string[];
  /** node_modules paths (e.g. 'stylis/dist/umd/stylis.js') whose exported state is scratch state; also learned automatically after 3 consecutive changes */
  ignoreModules?: string[];
  /** shared mode: own properties of the global object that the reset after each file never deletes nor reports (a register-once package that sets a global from a hook/test) */
  keepGlobals?: string[];
  sharedPool?: 'threads' | 'forks';
  /** emit test.projects even without quarantine (default false: projects cost ~4 % CPU) */
  alwaysProjects?: boolean;
  /** 'file' (default): vitest-guard adds its setup file first; 'import': your first setup file starts with `import '@jirikral/vitest-guard/setup'` (one module less per test file) */
  setup?: 'file' | 'import';
}
export declare function defineVitestGuardConfig(config: ViteUserConfig, options?: VitestGuardOptions): ViteUserConfig;
export declare function autoMemoryLimit(maxWorkers: number, o?: { totalmem?: number; heapLimit?: number }): number;
export declare function readQuarantine(root: string, mode: string, file?: string): string[];
export declare const SETUP_FILE: string;
/** last setup file in shared mode (marks the end of the setup files) */
export declare const SETUP_TAIL_FILE: string;
/** Path of a vitest-guard setup file as Vitest of the project at `root` can load it (a copy in node_modules/.vitest-guard/ when installed through a symlink). */
export declare function setupFileFor(root: string, file?: string): string;
export declare const DEFAULT_INCLUDE: string[];
export declare const DEFAULT_EXCLUDE: string[];
/** Name of mode auto's catch-all project: test files neither group lists run there, isolated. */
export declare const AUTO_REST: string;
export declare const VitestGuardSequencer: unknown;
