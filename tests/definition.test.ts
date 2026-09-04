import { describe, expect, it } from "vitest";
import type { RuntimeCapabilities, RuntimeDefinition } from "../src/definition/index.js";

describe("RuntimeDefinition", () => {
  it("accepts a minimal opencode definition", () => {
    const def: RuntimeDefinition = {
      identity: { id: "opencode", name: "OpenCode" },
      executable: { command: "opencode", versionArgs: ["--version"] },
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
    expect(def.identity.id).toBe("opencode");
    expect(def.input.type).toBe("stdin");
  });

  it("capabilities are checked via flags, not id", () => {
    const caps: RuntimeCapabilities = {
      streaming: true,
      sessionResume: false,
      modelSelection: false,
      reasoning: false,
      images: false,
      workspace: false,
    };
    // Rule 6: don't branch on id; branch on capability
    const canResume = caps.sessionResume;
    expect(canResume).toBe(false);
  });

  it("prompt input covers argv/stdin/file", () => {
    const inputs = [
      { type: "argv" as const },
      { type: "stdin" as const },
      { type: "file" as const },
    ];
    expect(inputs.map((i) => i.type)).toEqual(["argv", "stdin", "file"]);
  });
});
