import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession } from "../runtimes/opencode/session.js";
import { ClaudeSession } from "../runtimes/claude/session.js";
import { CodexSession } from "../runtimes/codex/session.js";
import {
  saveSessionRecord,
  loadSessionRecord,
  deleteSessionRecord,
  listSessionRecords,
  setSessionStoreDir,
} from "../src/core/session-store.js";

describe("session persistence", () => {
  let tmpStore: string;
  beforeEach(() => {
    tmpStore = mkdtempSync(join(tmpdir(), "test-store-"));
    setSessionStoreDir(tmpStore);
  });
  afterEach(() => {
    rmSync(tmpStore, { recursive: true, force: true });
    setSessionStoreDir(null);
  });

  it("save/load/delete round-trip", () => {
    const id = `test_persist_${String(Date.now())}`;
    saveSessionRecord({ id, nativeId: "native_123", cwd: "/tmp", updatedAt: Date.now() });
    const loaded = loadSessionRecord(id);
    expect(loaded?.nativeId).toBe("native_123");
    expect(listSessionRecords().some((r) => r.id === id)).toBe(true);
    deleteSessionRecord(id);
    expect(loadSessionRecord(id)).toBeNull();
  });

  it("sessions hydrate nativeId via resumeSessionId without prior run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "persist-sess-"));
    try {
      const op = new OpencodeSession({
        id: "op_resume",
        command: process.execPath,
        cwd,
        resumeSessionId: "op_native_1",
      });
      expect(op.nativeSessionId).toBe("op_native_1");
      await op.close();

      const cl = new ClaudeSession({
        id: "cl_resume",
        command: process.execPath,
        cwd,
        resumeSessionId: "cl_native_1",
      });
      expect(cl.nativeSessionId).toBe("cl_native_1");
      await cl.close();

      const cx = new CodexSession({
        id: "cx_resume",
        command: process.execPath,
        cwd,
        resumeSessionId: "thr_123",
      });
      expect(cx.nativeSessionId).toBe("thr_123");
      await cx.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loadSessionRecord returns null for missing id", () => {
    expect(loadSessionRecord("definitely-not-exist-xyz-123")).toBeNull();
  });
});
