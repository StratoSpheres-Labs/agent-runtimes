import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRun } from "../src/core/run.js";
import { ClaudeRun } from "../runtimes/claude/run.js";
import { AcpRun } from "../src/core/acp-run.js";
import { AcpTransport } from "../src/transport/acp.js";
import { OpencodeSession } from "../runtimes/opencode/session.js";
import { ClaudeSession } from "../runtimes/claude/session.js";
import { CodexSession } from "../runtimes/codex/session.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import { ClaudeRuntime } from "../runtimes/claude/runtime.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import { OpencodeAcpRuntime } from "../runtimes/opencode-acp/runtime.js";
import { buildOpencodeArgs } from "../runtimes/opencode/definition.js";
import { buildClaudeArgs, mergeClaudeAllowedTools } from "../runtimes/claude/definition.js";
import { clearLiveModels, rememberLiveModels } from "../src/discovery/models.js";
import { RuntimeSessionError } from "../src/core/errors.js";

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-input-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function mockTransport(mode: string): AcpTransport {
  return new AcpTransport({
    command: process.execPath,
    args: ["tests/fixtures/acp-mock-server.mjs", mode],
  });
}

describe("opencode agent selection", () => {
  it("buildOpencodeArgs emits --agent, drops blanks, rejects flag shapes", () => {
    expect(buildOpencodeArgs({ agent: "build" })).toEqual(
      expect.arrayContaining(["--agent", "build"]),
    );
    expect(buildOpencodeArgs({ agent: "  " })).not.toContain("--agent");
    expect(buildOpencodeArgs({})).not.toContain("--agent");
    expect(() => buildOpencodeArgs({ agent: "--evil" })).toThrow(/invalid opencode agent id/);
  });

  it("createSession accepts agent, rejects the rest", async () => {
    const rt = new OpencodeRuntime();
    const sess = await rt.createSession({ agent: "build" });
    expect(sess.id).toMatch(/^sess_/);
    await sess.close();
    await expect(rt.createSession({ agent: "--evil" })).rejects.toThrow(
      /invalid opencode agent id/,
    );
    await expect(rt.createSession({ workspace: { allowedPaths: [cwd] } })).rejects.toThrow(
      /allowedPaths/,
    );
    await expect(rt.createSession({ systemPrompt: "be nice" })).rejects.toThrow(/system prompts/);
    await expect(rt.createSession({ maxTokens: 100 })).rejects.toThrow(/token budgets/);
    await expect(rt.createSession({ maxBudgetUsd: 5 })).rejects.toThrow(/cost budgets/);
    await expect(rt.createSession({ outputSchema: { type: "object" } })).rejects.toThrow(
      /structured output/,
    );
    await expect(rt.createSession({ profile: "fast" })).rejects.toThrow(/config profiles/);
    await expect(rt.createSession({ allowedTools: ["Read"] })).rejects.toThrow(/tool allowlists/);
    await expect(
      rt.createSession({ seedMessages: [{ role: "user", text: "hi" }] }),
    ).rejects.toThrow(/history seeding/);
    // createSession runs real detect() spawns — headroom like mcp-discovery.
  }, 30000);
});

describe("claude input surface", () => {
  it("createSession accepts agent/systemPrompt/allowedTools, rejects sandboxMode", async () => {
    const rt = new ClaudeRuntime();
    const sess = await rt.createSession({
      agent: "build",
      systemPrompt: "be nice",
      maxBudgetUsd: 2.5,
      outputSchema: { type: "object" },
      allowedTools: ["Read"],
    });
    await sess.close();
    await expect(rt.createSession({ outputSchema: "{oops" })).rejects.toThrow(/not parseable JSON/);
    await expect(rt.createSession({ maxBudgetUsd: 0 })).rejects.toThrow(/positive dollar amount/);
    await expect(rt.createSession({ workspace: { sandboxMode: "x" } })).rejects.toThrow(
      /sandboxMode/,
    );
    await expect(rt.createSession({ agent: "--evil" })).rejects.toThrow(/invalid agent id/);
    await expect(rt.createSession({ maxTokens: 100 })).rejects.toThrow(/token budgets/);
    await expect(rt.createSession({ profile: "fast" })).rejects.toThrow(/config profiles/);
    await expect(rt.createSession({ allowedTools: ["--evil"] })).rejects.toThrow(
      /invalid allowedTools/,
    );
    // createSession runs real detect() spawns — headroom like mcp-discovery.
  }, 30000);

  it("mergeClaudeAllowedTools dedupes caller-first", () => {
    expect(mergeClaudeAllowedTools(["Read", "Read"], ["mcp__x__*", "Read"])).toEqual([
      "Read",
      "mcp__x__*",
    ]);
    expect(mergeClaudeAllowedTools(undefined, undefined)).toBeUndefined();
  });

  it("buildClaudeArgs sanitizes manual allowlists", () => {
    expect(buildClaudeArgs({ allowedTools: ["Read", "mcp__x__*"] })).toEqual(
      expect.arrayContaining(["--allowedTools", "Read mcp__x__*"]),
    );
    expect(() => buildClaudeArgs({ allowedTools: ["rm -rf"] })).toThrow(/invalid allowedTools/);
  });

  it("buildClaudeArgs emits --max-budget-usd verbatim", () => {
    expect(buildClaudeArgs({ maxBudgetUsd: 2.5 })).toEqual(
      expect.arrayContaining(["--max-budget-usd", "2.5"]),
    );
    expect(buildClaudeArgs({})).not.toContain("--max-budget-usd");
  });

  it("buildClaudeArgs emits --json-schema verbatim", () => {
    expect(buildClaudeArgs({ outputSchema: '{"type":"object"}' })).toEqual(
      expect.arrayContaining(["--json-schema", '{"type":"object"}']),
    );
    expect(buildClaudeArgs({})).not.toContain("--json-schema");
  });

  it("buildClaudeArgs emits --agent and --append-system-prompt", () => {
    expect(buildClaudeArgs({ agent: "build" })).toEqual(
      expect.arrayContaining(["--agent", "build"]),
    );
    expect(buildClaudeArgs({ systemPrompt: "be nice" })).toEqual(
      expect.arrayContaining(["--append-system-prompt", "be nice"]),
    );
    expect(buildClaudeArgs({ agent: "  ", systemPrompt: "  " })).not.toContain("--agent");
    expect(buildClaudeArgs({ agent: "  ", systemPrompt: "  " })).not.toContain(
      "--append-system-prompt",
    );
    expect(() => buildClaudeArgs({ agent: "--evil" })).toThrow(/invalid agent id/);
  });
});

describe("codex input surface", () => {
  it("createSession accepts profile, rejects permissionMode/agent", async () => {
    const rt = new CodexRuntime();
    const sess = await rt.createSession({ profile: "fast" });
    await sess.close();
    await expect(rt.createSession({ workspace: { permissionMode: "plan" } })).rejects.toThrow(
      /permissionMode/,
    );
    await expect(rt.createSession({ agent: "build" })).rejects.toThrow(/agent selection/);
    await expect(rt.createSession({ maxBudgetUsd: 5 })).rejects.toThrow(/cost budgets/);
    await expect(rt.createSession({ profile: "--evil" })).rejects.toThrow(/invalid profile id/);
    const auto = await rt.createSession({ workspace: { autoReview: true } });
    await auto.close();
    const schema = await rt.createSession({ outputSchema: { type: "object" } });
    await schema.close();
    await expect(rt.createSession({ outputSchema: "{oops" })).rejects.toThrow(/not parseable JSON/);
    await expect(
      rt.createSession({ workspace: { autoReview: true, sandboxMode: "read-only" } }),
    ).rejects.toThrow(/conflicts with workspace sandboxMode/);
    // createSession runs real detect() spawns — headroom like mcp-discovery.
  }, 30000);
});

describe("opencode-acp input surface", () => {
  it("createSession rejects reasoning and workspace", async () => {
    const rt = new OpencodeAcpRuntime();
    await expect(rt.createSession({ reasoning: { effort: "low" } })).rejects.toThrow(
      /reasoning controls/,
    );
    await expect(rt.createSession({ maxBudgetUsd: 5 })).rejects.toThrow(/cost budgets/);
    await expect(rt.createSession({ outputSchema: { type: "object" } })).rejects.toThrow(
      /structured output/,
    );
    await expect(rt.createSession({ workspace: { allowedPaths: [cwd] } })).rejects.toThrow(
      /allowedPaths/,
    );
  });
});

describe("per-run model overrides (fail fast, pre-spawn)", () => {
  it("opencode consults the run override first", async () => {
    rememberLiveModels("opencode", [{ id: "known-model" }]);
    try {
      const sess = new OpencodeSession({ id: "ovr", command: process.execPath, cwd });
      await expect(sess.run("hi", { model: "nope" })).rejects.toThrow(/unknown model "nope"/);
      const sess2 = new OpencodeSession({
        id: "ovr2",
        command: process.execPath,
        cwd,
        model: "known-model",
      });
      // Session model is known but the run override wins — still "nope".
      await expect(sess2.run("hi", { model: "nope" })).rejects.toThrow(/unknown model "nope"/);
      await sess.close();
      await sess2.close();
    } finally {
      clearLiveModels("opencode");
    }
  });

  it("claude and codex consult the run override first", async () => {
    rememberLiveModels("claude", [{ id: "sonnet" }]);
    rememberLiveModels("codex", [{ id: "gpt-5" }]);
    try {
      const claude = new ClaudeSession({ id: "c1", command: process.execPath, cwd });
      await expect(claude.run("hi", { model: "nope" })).rejects.toThrow(/unknown model "nope"/);
      const codex = new CodexSession({ id: "x1", command: process.execPath, cwd });
      await expect(codex.run("hi", { model: "nope" })).rejects.toThrow(/unknown model "nope"/);
      await claude.close();
      await codex.close();
    } finally {
      clearLiveModels("claude");
      clearLiveModels("codex");
    }
  });
});

describe("allowMidRunInput gating (pre-spawn)", () => {
  it("opencode, claude and codex reject the flag loudly", async () => {
    const opencode = new OpencodeSession({ id: "m1", command: process.execPath, cwd });
    await expect(opencode.run("hi", { allowMidRunInput: true })).rejects.toThrow(/mid-run input/);
    const claude = new ClaudeSession({ id: "m3", command: process.execPath, cwd });
    await expect(claude.run("hi", { allowMidRunInput: true })).rejects.toThrow(/mid-run input/);
    const codex = new CodexSession({ id: "m2", command: process.execPath, cwd });
    await expect(codex.run("hi", { allowMidRunInput: true })).rejects.toThrow(/mid-run input/);
    await opencode.close();
    await claude.close();
    await codex.close();
  });
});

describe("run.send()", () => {
  it("base DefaultRun always rejects (no guessed envelope)", async () => {
    const run = new DefaultRun("base1", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await expect(run.send("hi")).rejects.toThrow(/not supported/);
    await expect(run.send("hi")).rejects.toThrow(RuntimeSessionError);
    await run.close();
  });

  it("ClaudeRun.send rejects without an override (verified live: print mode is single-prompt)", async () => {
    const run = new ClaudeRun("closed1", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await expect(run.send("hi")).rejects.toThrow(/not supported/);
    await run.close();
  });

  it("ClaudeRun has no send override: base rejects even with stdin open", async () => {
    // Verified live (3 runs, 2.1.278) that print mode consumes only the
    // initial stdin prompt — follow-ups are never processed, so there is
    // no envelope to test here. Interactive answers use respondToPermission.
    const run = new ClaudeRun("echo-closed", {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      keepStdinOpen: true,
    });
    await expect(run.send("hi")).rejects.toThrow(/not supported/);
    await run.close();
  });

  it("AcpRun.send on a hanging turn resolves, then cancel ends with done", async () => {
    const run = new AcpRun("test:send", { transport: mockTransport("hang"), cwd: process.cwd() });
    try {
      await run.start("hi");
      await run.send("follow-up");
      await run.cancel();
      const types: string[] = [];
      for await (const e of run.events()) {
        types.push(e.type);
      }
      expect(types[0]).toBe("session_started");
      expect(types[types.length - 1]).toBe("done");
    } finally {
      await run.close();
    }
  }, 15000);

  it("AcpRun.send after finish rejects", async () => {
    const run = new AcpRun("test:send-done", {
      transport: mockTransport("turn"),
      cwd: process.cwd(),
    });
    try {
      await run.start("hi");
      for await (const e of run.events()) {
        if (e.type === "done") break;
      }
      await expect(run.send("late")).rejects.toThrow(/finished/);
    } finally {
      await run.close();
    }
  }, 15000);
});
