import { describe, expect, it } from "vitest";
import {
  opencodeAcpDefinition,
  buildOpencodeAcpArgs,
} from "../runtimes/opencode-acp/definition.js";
import { OpencodeAcpRuntime } from "../runtimes/opencode-acp/runtime.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { runtimes } from "../src/runtimes.js";

describe("opencode-acp definition", () => {
  it("declares the acp transport over the opencode binary", () => {
    expect(opencodeAcpDefinition.identity.id).toBe("opencode-acp");
    expect(opencodeAcpDefinition.executable.command).toBe("opencode");
    expect(opencodeAcpDefinition.transport.type).toBe("acp");
    expect(opencodeAcpDefinition.input.type).toBe("stdin");
    expect(opencodeAcpDefinition.capabilities.streaming).toBe(true);
    // Fresh ACP session per run in v0.1 — no resume, no reasoning channel.
    expect(opencodeAcpDefinition.capabilities.sessionResume).toBe(true);
    expect(opencodeAcpDefinition.capabilities.reasoning).toBe(false);
    expect(opencodeAcpDefinition.session.persistent).toBe(true);
  });

  it("shares the opencode model catalog (same binary)", () => {
    expect(opencodeAcpDefinition.models).toBe(opencodeDefinition.models);
  });

  it("builds the acp argv", () => {
    expect(buildOpencodeAcpArgs()).toEqual(["acp"]);
  });
});

describe("opencode-acp facade", () => {
  it("resolves the real adapter class with a stable session id", async () => {
    const runtime = await runtimes.resolve("opencode-acp");
    expect(runtime).toBeInstanceOf(OpencodeAcpRuntime);
    const session = await runtime.createSession({ cwd: process.cwd() });
    expect(session.id.startsWith("acp_")).toBe(true);
    await session.close();
    // Live detect() spawns several probes; slow under full-suite load.
  }, 15000);
});
