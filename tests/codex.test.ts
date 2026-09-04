import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexArgs,
  codexDefinition,
  resolveCodexLaunch,
} from "../runtimes/codex/definition.js";
import { CodexParser } from "../runtimes/codex/parser.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("codex buildArgs", () => {
  it("new session minimal", () => {
    expect(buildCodexArgs()).toEqual(["exec", "--json", "--skip-git-repo-check"]);
  });

  it("resume uses exec resume with thread_id", () => {
    expect(buildCodexArgs({ resumeThreadId: "thr_123" })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "thr_123",
    ]);
  });

  it("model and sandbox are forwarded", () => {
    expect(buildCodexArgs({ model: "o4-mini", sandboxMode: "workspace-write" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "o4-mini",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("reasoning.effort maps to quoted -c model_reasoning_effort", () => {
    // Quoted: `-c` takes TOML, and a bare word is not a valid TOML string.
    expect(buildCodexArgs({ reasoning: { effort: "high" } })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("reasoning applies to the resume branch too, thread id last", () => {
    expect(buildCodexArgs({ resumeThreadId: "thr_123", reasoning: { effort: "low" } })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="low"',
      "thr_123",
    ]);
  });

  it("resume maps sandbox to -c form (exec resume rejects --sandbox)", () => {
    const args = buildCodexArgs({ resumeThreadId: "thr_123", sandboxMode: "workspace-write" });
    expect(args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "thr_123",
    ]);
    expect(args).not.toContain("--sandbox");
  });

  it("definition is stdin + stdio + streaming", () => {
    expect(codexDefinition.input.type).toBe("stdin");
    expect(codexDefinition.transport.type).toBe("stdio");
    expect(codexDefinition.capabilities.streaming).toBe(true);
  });
});

describe("CodexParser fixtures", () => {
  const fixtures = ["thread.jsonl", "tool.jsonl"] as const;
  for (const name of fixtures) {
    it(`parses ${name} → RuntimeEvent`, () => {
      const raw = readFileSync(`runtimes/codex/fixtures/${name}`, "utf-8");
      const p = new CodexParser();
      const mid = Math.floor(raw.length / 2);
      const a = p.parse(enc(raw.slice(0, mid)));
      const b = p.parse(enc(raw.slice(mid)));
      const flushed = p.flush();
      const all = [...a, ...b, ...flushed];
      for (const e of all) {
        expect([
          "text_delta",
          "tool_started",
          "tool_finished",
          "error",
          "done",
          "session_started",
        ]).toContain(e.type);
      }
      expect(all.length).toBeGreaterThan(0);
    });
  }

  it("thread.started → session_started", () => {
    const p = new CodexParser();
    const evs = p.parse(enc(`{"type":"thread.started","thread_id":"thr_abc"}\n`));
    expect(evs[0]).toMatchObject({ type: "session_started", sessionId: "thr_abc" });
  });

  it("turn.completed → done", () => {
    const p = new CodexParser();
    const evs = p.parse(enc(`{"type":"turn.completed","status":"completed"}\n`));
    expect(evs[0]?.type).toBe("done");
  });

  it("turn.completed without status → done (codex-cli 0.150.1 shape)", () => {
    const p = new CodexParser();
    const evs = p.parse(enc(`{"type":"turn.completed","usage":{"output_tokens":5}}\n`));
    expect(evs.map((e) => e.type)).toEqual(["usage", "done"]);
    expect(evs[0]).toMatchObject({ type: "usage", outputTokens: 5 });
  });

  it("ignores turn.started (no error spam, cross-chunk safe)", () => {
    const p = new CodexParser();
    const line = `{"type":"turn.started"}\n`;
    const mid = Math.floor(line.length / 2);
    const a = p.parse(enc(line.slice(0, mid)));
    const b = p.parse(enc(line.slice(mid)));
    expect([...a, ...b, ...p.flush()]).toEqual([]);
  });

  it("agent_message surfaces text_delta once, without duplicate tool_finished", () => {
    const p = new CodexParser();
    const line = `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n`;
    const evs = [...p.parse(enc(line)), ...p.flush()];
    expect(evs.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "OK" },
    ]);
    expect(evs.filter((e) => e.type === "tool_finished")).toHaveLength(1);
    expect(evs.some((e) => e.type === "error")).toBe(false);
  });
});

describe("codex launch", () => {
  it("runs shimmed installs via host node", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-codex-"));
    try {
      const scriptRel = join("node_modules", "@openai", "codex", "bin", "codex.js");
      mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
      writeFileSync(join(dir, scriptRel), "// stub");
      const shim = join(dir, "codex.cmd");
      writeFileSync(shim, `@ECHO off\nnode  "%dp0%${scriptRel}" %*\n`);
      const launch = resolveCodexLaunch(shim, "win32");
      expect(launch.command).toBe(process.execPath);
      expect(launch.prependArgs).toEqual([join(dir, scriptRel)]);
      expect(launch.env).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes real executables through untouched", () => {
    expect(resolveCodexLaunch("/usr/local/bin/codex", "linux")).toEqual({
      command: "/usr/local/bin/codex",
      prependArgs: [],
    });
  });
});
