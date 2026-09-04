import { describe, expect, it } from "vitest";
import type { RuntimeDefinition } from "../src/definition/index.js";
import { DefaultRuntime } from "../src/core/runtime.js";
import { RuntimeRegistry } from "../src/core/registry.js";
import { RuntimeNotFoundError } from "../src/core/errors.js";

function makeDef(id: string): RuntimeDefinition {
  return {
    identity: { id, name: id },
    executable: { command: id, versionArgs: ["--version"] },
    input: { type: "stdin" },
    transport: { type: "stdio" },
    capabilities: {
      streaming: true,
      sessionResume: true,
      modelSelection: true,
      reasoning: true,
      images: false,
      workspace: false,
    },
    session: { persistent: true },
  };
}

describe("RuntimeRegistry", () => {
  it("resolves a registered runtime", async () => {
    const registry = new RuntimeRegistry();
    registry.register(makeDef("opencode"));
    const runtime = await registry.resolve("opencode");
    expect(runtime.id).toBe("opencode");
    expect(runtime.info().name).toBe("opencode");
    expect(registry.list()).toEqual(["opencode"]);
  });

  it("throws RuntimeNotFoundError for unknown id", async () => {
    const registry = new RuntimeRegistry();
    await expect(registry.resolve("missing")).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });

  it("capabilities come from definition, not id branching", async () => {
    const registry = new RuntimeRegistry();
    registry.register(makeDef("opencode"));
    const runtime = await registry.resolve("opencode");
    expect(runtime.capabilities().sessionResume).toBe(true);
    expect(runtime.capabilities().images).toBe(false);
  });
});

describe("DefaultRuntime.detect", () => {
  it("returns installed:false when executable missing", async () => {
    const runtime = new DefaultRuntime(makeDef("definitely-not-installed-binary-xyz"));
    const status = await runtime.detect();
    expect(status).toEqual({ installed: false });
  });

  it("detects opencode as installed (if available)", async () => {
    const runtime = new DefaultRuntime(makeDef("opencode"));
    const status = await runtime.detect();
    // On CI without opencode this will be false; on dev machine true.
    // Either way shape must be valid.
    if (status.installed) {
      expect(typeof status.executable).toBe("string");
      // version may be null if probe fails, but should be string | null
      expect(status.version === null || typeof status.version === "string").toBe(true);
    } else {
      expect(status).toEqual({ installed: false });
    }
    // Live version probes are slow under parallel load (cf. models.test.ts).
  }, 15000);
});
