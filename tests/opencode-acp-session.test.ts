import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAcpSession } from "../runtimes/opencode-acp/session.js";

let cwd: string;

beforeAll(() => {
  // Portable scratch dir — never hardcode C:\Temp (breaks macOS/Linux).
  cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("OpencodeAcpSession resume", () => {
  it("starts with no native id; resume() is a safe no-op", async () => {
    const sess = new OpencodeAcpSession({
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
    const sess = new OpencodeAcpSession({
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
