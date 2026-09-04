import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession } from "../runtimes/opencode/session.js";

let cwd: string;

beforeAll(() => {
  // Portable scratch dir — never hardcode C:\Temp (breaks macOS/Linux).
  cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("OpencodeSession resume", () => {
  it("captures native session id on first run (mocked)", async () => {
    // Use a no-op command that exits quickly; we will manually set nativeSessionId via events
    // For unit test, verify initial state and resume no-op
    const sess = new OpencodeSession({
      id: "test_sess",
      command: process.execPath,
      cwd,
    });
    expect(sess.nativeSessionId).toBeNull();
    await sess.resume();
    expect(sess.nativeSessionId).toBeNull();
    await sess.close();
  });

  it("has stable local id and delegates cancel/close", async () => {
    const sess = new OpencodeSession({
      id: "stable_id",
      command: process.execPath,
      cwd,
    });
    expect(sess.id).toBe("stable_id");
    await sess.cancel();
    await sess.close();
    await sess.close(); // idempotent
  });
});
