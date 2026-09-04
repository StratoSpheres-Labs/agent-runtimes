import { describe, expect, it } from "vitest";
import { StdioTransport } from "../src/transport/stdio.js";

describe("StdioTransport", () => {
  it("starts, yields stdout bytes, and closes", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi'); process.stdout.write(' there')"],
    });
    await t.start();
    const chunks: string[] = [];
    for await (const b of t.events()) {
      chunks.push(new TextDecoder().decode(b));
    }
    expect(chunks.join("")).toBe("hi there");
    await t.close();
    expect(t.state).toBe("stopped");
  });

  it("write() pipes to stdin", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', d=>process.stdout.write(d))"],
    });
    await t.start();
    // Collect in background
    const acc: string[] = [];
    const iter = (async () => {
      for await (const b of t.events()) {
        acc.push(new TextDecoder().decode(b));
      }
    })();
    await t.write("hello");
    (t as unknown as { endStdin: () => void }).endStdin();
    await iter;
    expect(acc.join("")).toBe("hello");
    await t.close();
  });

  it("does not parse — raw bytes preserved", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(\'{"type":"text_delta"}\')'],
    });
    await t.start();
    const chunks: string[] = [];
    for await (const b of t.events()) {
      chunks.push(new TextDecoder().decode(b));
    }
    // Transport must NOT have parsed; raw JSON still there
    expect(chunks.join("")).toBe('{"type":"text_delta"}');
    await t.close();
  });
});
