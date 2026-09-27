import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession } from "../runtimes/codex/session.js";

let cwd: string;

beforeAll(() => {
  // Portable scratch dir — never hardcode C:\Temp (breaks macOS/Linux).
  cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("CodexSession resume", () => {
  it("starts with no native id; resume() is a safe no-op", async () => {
    const sess = new CodexSession({
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
    const sess = new CodexSession({
      id: "stable_id",
      command: process.execPath,
      cwd,
    });
    expect(sess.id).toBe("stable_id");
    await sess.cancel();
    await sess.close();
    await sess.close(); // idempotent
  });

  it("rejects a flag-shaped resumeSessionId at construction", async () => {
    expect(
      () =>
        new CodexSession({
          id: "evil",
          command: process.execPath,
          cwd,
          resumeSessionId: "exec resume --json",
        }),
    ).toThrow(/resumeSessionId/);
    const ok = new CodexSession({
      id: "ok",
      command: process.execPath,
      cwd,
      resumeSessionId: "01a0e0d7-5410-73c3-9abe-04fd10c7efc4",
    });
    expect(ok.nativeSessionId).toBe("01a0e0d7-5410-73c3-9abe-04fd10c7efc4");
    await ok.close();
  });

  it("refuses a new run while the previous run was never drained (no silent fresh thread)", async () => {
    const sess = new CodexSession({
      id: "w1",
      command: "agent-runtimes-missing-xyz",
      cwd,
    });
    const run1 = await sess.run("x");
    await expect(sess.run("y")).rejects.toThrow(/not drained to done/);
    for await (const e of run1.events()) {
      if (e.type === "done") break;
    }
    const run3 = await sess.run("z");
    expect(run3.done).toBe(false);
    await sess.close();
  });
});
