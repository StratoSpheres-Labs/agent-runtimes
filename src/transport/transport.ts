/**
 * Transport — raw byte mover (Rule 3: must NOT parse agent events).
 * Phase 7: Dev_Docs 946-981
 */

export interface RuntimeTransport {
  /** Spawn and connect */
  start(): Promise<void>;
  /** Write to stdin */
  write(data: Uint8Array | string): Promise<void>;
  /** Raw byte stream from stdout (stderr is separate; caller may merge) */
  events(): AsyncIterable<Uint8Array>;
  /** Full cleanup (stdin/stdout/stderr/process/listeners/timers) */
  close(): Promise<void>;
}
