import { describe, expect, it } from "vitest";
import { capabilitiesFromHelp, probeHelpFlags } from "../src/discovery/capabilities.js";
import type { RuntimeCapabilities } from "../src/definition/capability.js";
import { claudeDefinition } from "../runtimes/claude/definition.js";
import { findExecutable } from "../src/discovery/executable.js";

const base: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: false,
  workspace: false,
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

  it("finds --add-dir through claude's help args when installed", async () => {
    const exe = await findExecutable("claude", claudeDefinition.executable.aliases ?? []);
    if (!exe) return;
    const helpArgs = claudeDefinition.executable.helpArgs ?? ["--help"];
    const flags = await probeHelpFlags(exe, ["--add-dir"], helpArgs);
    expect(flags["--add-dir"]).toBe(true);
    // findExecutable fans out to version probes and `claude -p` starts
    // slowly (plugin sync) — allow headroom under full-suite load.
  }, 30000);
});
