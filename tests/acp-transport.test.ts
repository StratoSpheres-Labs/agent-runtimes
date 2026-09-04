import { describe, expect, it } from "vitest";
import { AcpTransport } from "../src/transport/acp.js";
import { RuntimeProtocolError, RuntimeTimeoutError } from "../src/core/errors.js";

function mockArgs(mode: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["tests/fixtures/acp-mock-server.mjs", mode] };
}

describe("AcpTransport", () => {
  it("handshakes and correlates requests", async () => {
    const t = new AcpTransport(mockArgs("turn"));
    try {
      await t.start();
      const init = await t.request<{ protocolVersion: number }>("initialize", {
        protocolVersion: 1,
      });
      expect(init.protocolVersion).toBe(1);
      const created = await t.request<{ sessionId: string }>("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(created.sessionId).toBe("ses_mock");
    } finally {
      await t.close();
    }
    expect(t.state).toBe("stopped");
  }, 15000);

  it("routes unknown methods to a -32601 error (never hangs)", async () => {
    const t = new AcpTransport(mockArgs("turn"));
    try {
      await t.start();
      await expect(t.request("nope/method")).rejects.toBeInstanceOf(RuntimeProtocolError);
    } finally {
      await t.close();
    }
  }, 15000);

  it("times out a hung request and stays usable", async () => {
    const t = new AcpTransport(mockArgs("hang"));
    try {
      await t.start();
      await expect(t.request("session/prompt", {}, { timeoutMs: 300 })).rejects.toBeInstanceOf(
        RuntimeTimeoutError,
      );
      // Transport still usable after a timeout.
      const init = await t.request<{ protocolVersion: number }>("initialize", {});
      expect(init.protocolVersion).toBe(1);
    } finally {
      await t.close();
    }
  }, 15000);

  it("close() is idempotent and rejects afterwards", async () => {
    const t = new AcpTransport(mockArgs("turn"));
    await t.start();
    await t.close();
    await t.close();
    await expect(t.request("initialize", {})).rejects.toBeInstanceOf(RuntimeProtocolError);
  }, 15000);
});
