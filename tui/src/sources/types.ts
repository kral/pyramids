// Swappable event-source layer. The UI only talks to this interface: IPC (daemon), file tail,
// stdin and the in-process mock all implement it.
import type { VtoEvent } from '../events.js';

export type SourceStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error';

export interface SourceHandlers {
  /** called once per chunk/tick with every event decoded from it – callers batch on this */
  onEvents(evs: VtoEvent[]): void;
  onStatus?(s: SourceStatus, detail?: string): void;
}

/**
 * Requests the UI sends to the daemon. Names mirror the MCP tools in MCP.md (`rerun_failed`), plus
 * `enqueue_task` for the MCP task queue. See protocol.ts for the wire format.
 */
export type DaemonRequest =
  | { method: 'rerun_failed'; params: { runId: string; ids?: string[] } }
  | { method: 'enqueue_task'; params: { task: unknown } };

export interface EventSource {
  readonly label: string;
  /** false for read-only sources (file, stdin): r/R/a show a hint instead */
  readonly canRequest: boolean;
  start(h: SourceHandlers): void;
  request(req: DaemonRequest): Promise<unknown>;
  close(): void;
}

export class ReadOnlyError extends Error { constructor() { super('read-only source'); } }
