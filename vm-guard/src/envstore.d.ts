export interface EnvEntry {
  group: 'dom' | 'node';
  source: 'probe' | 'static';
  env: string | null;
  dom: boolean | null;
  at: string;
  by?: string;
  /** DOM miss: failed in the node group after touching this DOM global (sticky, strongest evidence) */
  miss?: { key: string };
  via?: string;
  [extension: string]: unknown;
}
export type EnvRecord = Partial<EnvEntry> & { source: 'probe' | 'static' };
export type EnvEntries = Record<string, EnvRecord> | Map<string, EnvRecord> | Array<[string, EnvRecord] | (EnvRecord & { file: string })>;
export interface UpdateEnvOptions { producer?: string; remove?: string[]; write?: boolean; lock?: { timeoutMs?: number; staleMs?: number } }
export interface UpdateEnvResult { files: Record<string, EnvEntry>; changed: string[]; rejected: string[]; written: boolean; locked: boolean }
export declare const ENV_FORMAT: 'vto-env/1';
export declare const DOM_ENVS: Set<string>;
export declare function envStateDir(root: string): string;
export declare function envFilePath(root: string): string;
export declare function envKey(root: string, file: string): string | null;
export declare function envRank(entry: unknown): 0 | 1 | 2 | 3;
export declare function normalizeEnvEntry(rec: unknown, o?: { producer?: string; at?: string }): EnvEntry | null;
export declare function mergeEnvEntry(cur: EnvEntry | undefined, next: EnvEntry): EnvEntry | undefined;
export declare function readEnv(root: string): { files: Record<string, EnvEntry>; producer: string | null; updatedAt: string | null };
export declare function updateEnv(root: string, entries: EnvEntries, o?: UpdateEnvOptions): UpdateEnvResult;
export declare function removeEnvEntries(root: string, files: string[], o?: UpdateEnvOptions): UpdateEnvResult;
export declare function foldEnvRecords(root: string, o?: { producer?: string }): Record<string, EnvEntry>;
export declare function withEnvLock<T>(root: string, fn: (locked: boolean) => T, o?: { timeoutMs?: number; staleMs?: number }): { locked: boolean; value: T };
