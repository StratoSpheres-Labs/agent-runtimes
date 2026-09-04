import type { RuntimeEvent } from "../events/runtime-event.js";

/**
 * RuntimeParser — Rule 4: must NOT manage process/session lifecycle.
 * Owns buffering for split JSON across chunks.
 * Phase 8: Dev_Docs 985-1062
 */
export interface RuntimeParser {
  /** Feed a raw chunk; returns zero or more complete RuntimeEvents */
  parse(chunk: Uint8Array): RuntimeEvent[];
  /** Flush any buffered partial line (e.g. on stream end) */
  flush(): RuntimeEvent[];
  /** Reset internal buffer */
  reset(): void;
}
