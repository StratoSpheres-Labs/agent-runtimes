import { describe, expect, it } from "vitest";
import {
  ADVISORY_PROBE_FLAGS,
  capabilitiesFromHelp,
  probeHelpFlags,
  probeHelpFlagsDetailed,
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
  subAgents: false,
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

describe("capabilitiesFromHelp — an unprobed flag is not a negative", () => {
  it("keeps base when every candidate is 'unknown'", () => {
    // The timeout case that used to strip capabilities off a healthy CLI.
    const unknown = {
      "--resume": "unknown",
      "--output-format stream-json": "unknown",
      "--add-dir": "unknown",
    } as const;
    const caps = capabilitiesFromHelp(base, unknown);
    expect(caps.streaming).toBe(true);
    expect(caps.sessionResume).toBe(true);
    // base.workspace is already false; the point is it was not *decided*.
    expect(caps.workspace).toBe(false);
  });

  it("never lets one 'unknown' advertise a capability", () => {
    // `Boolean("unknown") === true`, so a `.some(Boolean)` spelling here
    // would upgrade every capability on a failed probe. That is the inverse
    // bug and just as wrong.
    const caps = capabilitiesFromHelp(
      { ...base, streaming: false, sessionResume: false, workspace: false },
      {
        "--resume": "unknown",
        "--output-format stream-json": "unknown",
        "--add-dir": "unknown",
      },
    );
    expect(caps.streaming).toBe(false);
    expect(caps.sessionResume).toBe(false);
    expect(caps.workspace).toBe(false);
  });

  it("still downgrades on a DEFINITIVE absence", () => {
    // The gate has to keep working: a CLI that genuinely lacks the flag must
    // not advertise the capability. base.streaming is true here on purpose.
    const caps = capabilitiesFromHelp(base, {
      "--output-format stream-json": false,
      "--resume": false,
      "--session": false,
      resume: false,
    });
    expect(caps.streaming).toBe(false);
  });

  it("upgrades when a flag is definitively present", () => {
    const caps = capabilitiesFromHelp({ ...base, workspace: false }, { "--add-dir": true });
    expect(caps.workspace).toBe(true);
  });

  it("treats an absent key like 'unknown', not like false", () => {
    // An empty map is what a failed probe used to collapse to.
    const caps = capabilitiesFromHelp(base, {});
    expect(caps.streaming).toBe(true);
  });
});

describe("probeHelpFlagsDetailed", () => {
  it("reports ok and real verdicts for readable help (hermetic)", async () => {
    const script = `console.log("--agent a\\n--add-dir b")`;
    const probe = await probeHelpFlagsDetailed(
      process.execPath,
      ["--agent", "--add-dir", "--profile"],
      ["-e", script],
    );
    expect(probe.status).toBe("ok");
    expect(probe.flags).toEqual({ "--agent": true, "--add-dir": true, "--profile": false });
  });

  it("reports 'error' for a missing binary, with 'unknown' — never false", async () => {
    const probe = await probeHelpFlagsDetailed("definitely-not-exist-xyz", [
      "--model",
      "--session",
    ]);
    expect(probe.status).toBe("error");
    // The load-bearing assertion: a false here would read as "this CLI has no
    // --model", i.e. a finding nobody made.
    expect(probe.flags).toEqual({ "--model": "unknown", "--session": "unknown" });
  });

  it("keeps the boolean view fail-safe (unprobed reads false)", async () => {
    // Published behaviour of `probeHelpFlags` is unchanged: omitting a flag is
    // safer than passing one the CLI may reject.
    const probe = await probeHelpFlags("definitely-not-exist-xyz", ["--model"]);
    expect(probe).toEqual({ "--model": false });
  });

  it("reports every requested flag, never omits a key", async () => {
    const probe = await probeHelpFlagsDetailed("definitely-not-exist-xyz", ["--a", "--b", "--c"]);
    expect(Object.keys(probe.flags).sort()).toEqual(["--a", "--b", "--c"]);
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
    const probe = await probeHelpFlagsDetailed(exe, ["--add-dir"], helpArgs);
    // The original bug this test kept hitting: it asserted against the boolean
    // probe, where a 10s timeout is indistinguishable from "claude has no
    // --add-dir". Under full-suite load the probe times out, the false
    // negative fails the assertion, and nothing in the message says the probe
    // never actually looked. Gate on the outcome instead.
    if (probe.status !== "ok") return;
    expect(probe.flags["--add-dir"]).toBe(true);
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
        subAgents: false,
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
