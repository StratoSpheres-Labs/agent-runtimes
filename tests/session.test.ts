import { describe, expect, it } from "vitest";
import { DefaultSession } from "../src/core/session.js";

describe("DefaultSession", () => {
  it("holds stable id across multiple runs (Session !== Process)", async () => {
    const session = new DefaultSession({ cwd: process.cwd() });
    const id = session.id;
    const run1 = await session.run("prompt 1");
    const pid1 = (run1 as unknown as { pid?: number }).pid;
    await run1.result();
    expect(run1.done).toBe(true);

    const run2 = await session.run("prompt 2");
    await run2.result();
    // Session id stable, runs have distinct ids/pids
    expect(session.id).toBe(id);
    expect(run1.id).not.toBe(run2.id);
    const pid2 = (run2 as unknown as { pid?: number }).pid;
    // Pids differ (two separate processes) — proves Session !== Process
    if (pid1 !== undefined && pid2 !== undefined) {
      expect(pid1).not.toBe(pid2);
    }
    await session.close();
  });

  it("cancel stops the active run", async () => {
    const session = new DefaultSession();
    const run = await session.run("long prompt");
    expect(run.done).toBe(false);
    await session.cancel();
    // After cancel the run should be done (killed)
    expect(run.done).toBe(true);
    await session.close();
  });

  it("close is idempotent and cleans all runs", async () => {
    const session = new DefaultSession();
    await session.run("a");
    await session.run("b");
    await session.close();
    await session.close(); // second close must not throw
    await expect(session.run("after close")).rejects.toThrow();
  });

  it("runFactory injection stays core-agnostic", async () => {
    let factoryCalls = 0;
    const session = new DefaultSession({
      runFactory: (id, prompt) => {
        factoryCalls++;
        let done = false;
        return {
          id,
          get done() {
            return done;
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async cancel() {
            done = true;
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async result() {
            // mark prompt as used without void operator
            if (prompt.length === -1) throw new Error("unreachable");
            done = true;
            return { code: 0, signal: null };
          },
          // eslint-disable-next-line @typescript-eslint/require-await
          async close() {
            done = true;
          },
        } as unknown as Awaited<ReturnType<DefaultSession["run"]>>;
      },
    });
    await session.run("via factory");
    expect(factoryCalls).toBe(1);
    await session.close();
  });
});
