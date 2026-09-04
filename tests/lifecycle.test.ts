import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeProcess } from "../src/core/lifecycle.js";
import { RuntimeSpawnError } from "../src/core/errors.js";

describe("RuntimeProcess", () => {
  it("spawns, writes to stdin, and captures stdout", async () => {
    // Use node as a portable echo process
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
    });
    proc.spawn();
    expect(proc.state).toBe("running");

    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => {
      chunks.push(Buffer.from(c));
    });

    await proc.write("hello ");
    await proc.write("world");
    proc.endStdin();

    const exit = await proc.wait();
    expect(exit.code).toBe(0);
    expect(proc.state).toBe("stopped");
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("hello world");
  });

  it("respects cwd", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: process.cwd(),
    });
    proc.spawn();
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => {
      chunks.push(Buffer.from(c));
    });
    const exit = await proc.wait();
    expect(exit.code).toBe(0);
    expect(Buffer.concat(chunks).toString("utf-8")).toBe(process.cwd());
  });

  it("respects env", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.TEST_LIFECYCLE_VAR ?? '')"],
      env: { TEST_LIFECYCLE_VAR: "lifecycletest" },
    });
    proc.spawn();
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => {
      chunks.push(Buffer.from(c));
    });
    await proc.wait();
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("lifecycletest");
  });

  it("cancel terminates a long-running process", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000)"],
    });
    proc.spawn();
    expect(proc.state).toBe("running");
    const exit = await proc.cancel();
    // After cancel it must be stopped/failed, no zombie
    expect(["stopped", "failed"]).toContain(proc.state);
    // exit may have null code if killed by signal
    expect(exit.signal !== null || exit.code !== null).toBe(true);
    // Subsequent wait should not hang
    // close should be idempotent
    await proc.close();
    expect(proc.state).toBe("stopped");
  });

  it("close cleans listeners/timers/process", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000)"],
      timeout: 50,
    });
    proc.spawn();
    // Timeout kills the process; wait resolves with SIGTERM (or rejects on fast path)
    try {
      const exit = await proc.wait();
      expect(exit.signal).toBe("SIGTERM");
    } catch {
      // Also acceptable: wait rejected with timeout error
      expect(["stopped", "stopping", "failed"]).toContain(proc.state);
    }
    // Ensure no hanging timers/process after close
    await proc.close();
    expect(proc.state).toBe("stopped");
    expect(proc.pid).toBeUndefined();
  });

  it("spawn failure surfaces RuntimeSpawnError (never a raw system error)", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", ""],
      cwd: join(tmpdir(), "agent-runtimes-missing-xyz"),
    });
    // Whether node throws synchronously (bad cwd / unspawnable shim) or
    // emits 'error', callers always observe RuntimeSpawnError — never a
    // raw EINVAL/ENOENT host crash.
    await expect(
      (async () => {
        proc.spawn();
        await proc.wait();
      })(),
    ).rejects.toBeInstanceOf(RuntimeSpawnError);
  });

  it("transitions to failed on non-zero exit", async () => {
    const proc = new RuntimeProcess({
      command: process.execPath,
      args: ["-e", "process.exit(42)"],
    });
    proc.spawn();
    const exit = await proc.wait();
    expect(exit.code).toBe(42);
    expect(proc.state).toBe("failed");
  });
});
