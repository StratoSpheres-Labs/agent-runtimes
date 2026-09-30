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

  it("rejects a flag-shaped resumeSessionId at construction", async () => {
    expect(
      () =>
        new OpencodeSession({
          id: "evil",
          command: process.execPath,
          cwd,
          resumeSessionId: "--dangerously-skip-permissions",
        }),
    ).toThrow(/resumeSessionId/);
    const ok = new OpencodeSession({
      id: "ok",
      command: process.execPath,
      cwd,
      resumeSessionId: "ses_abc123",
    });
    expect(ok.nativeSessionId).toBe("ses_abc123");
    await ok.close();
  });

  it("refuses a new run while the previous run was never drained (no silent fresh session)", async () => {
    // W1: the native id is captured by the events wrapper — an undrained
    // run 1 means run 2 would silently lose the resume. Fail loudly.
    const sess = new OpencodeSession({
      id: "w1",
      command: "agent-runtimes-missing-xyz",
      cwd,
    });
    const run1 = await sess.run("x"); // spawn fails async; stream ends error+done
    await expect(sess.run("y")).rejects.toThrow(/not drained to done/);
    // Drain run 1 to done (idless — the CLI died before session_started):
    // a fresh start is now provably safe and allowed.
    for await (const e of run1.events()) {
      if (e.type === "done") break;
    }
    const run3 = await sess.run("z");
    expect(run3.done).toBe(false);
    await sess.close();
  });

  it("queue:true defers the guard to dispatch (no throw at enqueue)", async () => {
    // Same undrained setup as above, but queued: enqueue must not throw
    // (the guard moves to createRun at dispatch). Draining run 1 to its
    // idless done proves a fresh start safe, so run 2 dispatches.
    const sess = new OpencodeSession({
      id: "wq",
      command: "agent-runtimes-missing-xyz",
      cwd,
    });
    const run1 = await sess.run("x");
    const p2 = sess.run("y", { queue: true });
    for await (const e of run1.events()) {
      if (e.type === "done") break;
    }
    const run2 = await p2;
    expect(run2.done).toBe(false);
    for await (const e of run2.events()) {
      if (e.type === "done") break;
    }
    expect(run2.done).toBe(true);
    await sess.close();
  });
});
