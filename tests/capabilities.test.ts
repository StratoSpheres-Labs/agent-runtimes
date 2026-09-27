import { describe, expect, it } from "vitest";
import {
  ADVISORY_PROBE_FLAGS,
  capabilitiesFromHelp,
  probeHelpFlags,
} from "../src/discovery/capabilities.js";
import { DefaultRuntime } from "../src/core/runtime.js";
import type { RuntimeDefinition } from "../src/definition/index.js";
import type { RuntimeCapabilities } from "../src/definition/capability.js";
import { claudeDefinition } from "../runtimes/claude/definition.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { codexDefinition } from "../runtimes/codex/definition.js";
import { findExecutable } from "../src/discovery/executable.js";

const base: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: false,
  workspace: false,
  agentSelection: false,
  midRunInput: false,
  historySeed: false,
  systemPrompt: false,
  maxTokens: false,
  costBudget: false,
  structuredOutput: false,
  toolAllowlist: false,
  profileSelection: false,
};

describe("capabilitiesFromHelp", () => {
  it("keeps base when flags present", () => {
    const help = {
      "--resume": true,
      "--session": true,
      "--model": true,
      "--output-format stream-json": true,
    };
    const caps = capabilitiesFromHelp(base, help);
    expect(caps.sessionResume).toBe(true);
    expect(caps.streaming).toBe(true);
  });

  it("falls back to base when flag missing", () => {
    const help = { "--resume": false, "--session": false };
    const caps = capabilitiesFromHelp(base, help);
    expect(caps.sessionResume).toBe(true); // base true retained (v0.1 gate is permissive)
  });
});

describe("probeHelpFlags", () => {
  it("detects opencode help flags", async () => {
    const flags = await probeHelpFlags("opencode", ["--model", "--session", "--help"]);
    // opencode should have --model and --session
    expect(typeof flags["--model"]).toBe("boolean");
    expect(typeof flags["--session"]).toBe("boolean");
  });

  it("returns false for missing binary", async () => {
    const flags = await probeHelpFlags("definitely-not-exist-xyz", ["--model"]);
    expect(flags["--model"]).toBe(false);
  });

  it("claude declares subcommand help args", () => {
    // --add-dir only lives under `claude -p` on older builds (open-design
    // issue #430) — the definition must point the prober there.
    expect(claudeDefinition.executable.helpArgs).toEqual(["-p", "--help"]);
  });

  it("opencode/codex point the prober at their subcommand help", () => {
    // Run/exec flags never appear in top-level --help (verified live).
    expect(opencodeDefinition.executable.helpArgs).toEqual(["run", "--help"]);
    expect(codexDefinition.executable.helpArgs).toEqual(["exec", "--help"]);
  });

  it("finds --add-dir through claude's help args when installed", async () => {
    const exe = await findExecutable("claude", claudeDefinition.executable.aliases ?? []);
    if (!exe) return;
    const helpArgs = claudeDefinition.executable.helpArgs ?? ["--help"];
    const flags = await probeHelpFlags(exe, ["--add-dir"], helpArgs);
    expect(flags["--add-dir"]).toBe(true);
    // findExecutable fans out to version probes and `claude -p` starts
    // slowly (plugin sync) — allow headroom under full-suite load.
  }, 30000);

  it("advisory list holds only live-verified flags", () => {
    // Every entry must be a flag this library actually observed in a CLI
    // --help (never speculative); bare `-p` stays out (substring matching
    // would false-positive on `--port` etc.).
    for (const want of [
      "--agent",
      "--add-dir",
      "--profile",
      "--allowedTools",
      "--dangerously-bypass-approvals-and-sandbox",
      "--variant",
    ]) {
      expect(ADVISORY_PROBE_FLAGS).toContain(want);
    }
    expect(ADVISORY_PROBE_FLAGS).not.toContain("-p");
  });

  it("maps canned help text to flag hits (hermetic)", async () => {
    const script = `console.log("--agent agent to use\\n--add-dir extra dirs\\n--port 8080")`;
    const flags = await probeHelpFlags(
      process.execPath,
      ["--agent", "--add-dir", "--profile"],
      ["-e", script],
    );
    expect(flags).toEqual({ "--agent": true, "--add-dir": true, "--profile": false });
  });

  it("DefaultRuntime.probeFlags never throws (doctor depends on it)", async () => {
    const def: RuntimeDefinition = {
      identity: { id: "ghost", name: "Ghost" },
      executable: { command: "definitely-not-exist-xyz" },
      input: { type: "stdin" },
      transport: { type: "stdio" },
      capabilities: {
        streaming: true,
        sessionResume: true,
        modelSelection: true,
        reasoning: true,
        images: false,
        workspace: false,
        agentSelection: false,
        midRunInput: false,
        historySeed: false,
        systemPrompt: false,
        maxTokens: false,
        costBudget: false,
        structuredOutput: false,
        toolAllowlist: false,
        profileSelection: false,
      },
      session: { persistent: true },
    };
    // Missing binary yields all-false (never a throw) — doctor renders no row.
    await expect(new DefaultRuntime(def).probeFlags(["--agent"])).resolves.toEqual({
      "--agent": false,
    });
  });
});
