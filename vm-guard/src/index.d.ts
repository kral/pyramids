import type { ViteUserConfig } from 'vitest/config';
export interface VmGuardOptions {
  /** 'vm' = pool vmThreads (default), 'shared' = threads + isolate:false. Env VM_GUARD_MODE=vm|shared|isolated|off overrides. */
  mode?: 'vm' | 'shared' | 'auto';
  /** mode 'auto': per group/project mode override, e.g. { dom: 'vm', node: 'shared' } ('vm' | 'shared' | 'isolated') */
  autoModes?: Record<string, 'vm' | 'shared' | 'isolated'>;
  /** mode 'auto' with user projects: keep explicit project pools */
  respectPools?: boolean;
  /** mode 'auto': 'node' = files of a DOM-configured suite that never touch the DOM (measured, else static) move to the node group with environment node (opt-in; default routes by the configured environment) */
  nodeEnvironment?: 'node' | null;
  quarantineFile?: string;
  /** bytes or Vitest string ('1.5GB', '30%'); default autoMemoryLimit(maxWorkers) */
  memoryLimit?: number | string;
  /** extra server.deps.inline entries */
  inline?: (string | RegExp)[];
  /** what to do when a file starts with dirty state: default 'warn' */
  onDirty?: 'warn' | 'error' | 'silent';
  /** duplicate React check: true = throw (default), 'warn', false */
  react?: boolean | 'warn';
  realm?: boolean; probes?: boolean; restoreEnv?: boolean; reset?: boolean; log?: boolean;
  /** shared mode: vi.resetModules() after every file (default true). Without it a module that a cached
   *  importer loaded first keeps that binding: vi.mock of a transitively imported module silently stops applying. */
  resetModules?: boolean;
  /** diagnostics (pollution diff at file end, residual after reset, node_modules export-state scan); default: on only under the vm-guard CLI (VM_GUARD_DIAG=1) */
  diag?: boolean; moduleState?: boolean; detectPollution?: boolean;
  ignoreListeners?: string[];
  /** node_modules paths (e.g. 'stylis/dist/umd/stylis.js') whose exported state is scratch state; also learned automatically after 3 consecutive changes */
  ignoreModules?: string[];
  sharedPool?: 'threads' | 'forks';
  /** emit test.projects even without quarantine (default false: projects cost ~4 % CPU) */
  alwaysProjects?: boolean;
  /** 'file' (default): vm-guard adds its setup file first; 'import': your first setup file starts with `import 'vm-guard/setup'` (one module less per test file) */
  setup?: 'file' | 'import';
}
export declare function defineVmGuardConfig(config: ViteUserConfig, options?: VmGuardOptions): ViteUserConfig;
export declare function autoMemoryLimit(maxWorkers: number, o?: { totalmem?: number; heapLimit?: number }): number;
export declare function readQuarantine(root: string, mode: string, file?: string): string[];
export declare const SETUP_FILE: string;
