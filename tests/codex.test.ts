import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexArgs,
  codexDefinition,
  resolveCodexLaunch,
  resolveCodexSandboxMode,
} from "../runtimes/codex/definition.js";
import { CodexParser } from "../runtimes/codex/parser.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("codex sandbox default (daemon parity)", () => {
  it("explicit mode always wins", () => {
    expect(resolveCodexSandboxMode("read-only", "win32", {})).toBe("read-only");
    expect(resolveCodexSandboxMode("read-only", "linux", {})).toBe("read-only");
  });

  it("win32/WSL default to danger-full-access, POSIX to workspace-write", () => {
    expect(resolveCodexSandboxMode(undefined, "win32", {})).toBe("danger-full-access");
    expect(resolveCodexSandboxMode(undefined, "linux", {})).toBe("workspace-write");
    expect(resolveCodexSandboxMode(undefined, "darwin", {})).toBe("workspace-write");
    expect(resolveCodexSandboxMode(undefined, "linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(
      "danger-full-access",
    );
  });

  it("OD_CODEX_SANDBOX env overrides the platform default", () => {
    expect(
      resolveCodexSandboxMode(undefined, "linux", { OD_CODEX_SANDBOX: "danger-full-access" }),
    ).toBe("danger-full-access");
  });
});

describe("codex buildArgs", () => {
  it("new session pins sandbox default + cwd, workspace-write gains network access", () => {
    expect(buildCodexArgs({ sandboxMode: "read-only", cwd: "/proj" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      "/proj",
    ]);
    expect(buildCodexArgs({ sandboxMode: "workspace-write" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });

  it("resume uses exec resume with thread_id (sandbox default resolved per platform)", () => {
    const sandbox = resolveCodexSandboxMode(undefined);
    const network =
      sandbox === "workspace-write" ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
    expect(buildCodexArgs({ resumeThreadId: "thr_123" })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      `sandbox_mode="${sandbox}"`,
      ...network,
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
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });

  it("reasoning.effort maps to quoted -c model_reasoning_effort", () => {
    // Quoted: `-c` takes TOML, and a bare word is not a valid TOML string.
    expect(buildCodexArgs({ reasoning: { effort: "high" }, sandboxMode: "read-only" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("reasoning applies to the resume branch too, thread id last", () => {
    expect(
      buildCodexArgs({
        resumeThreadId: "thr_123",
        reasoning: { effort: "low" },
        sandboxMode: "read-only",
      }),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
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
      "-c",
      "sandbox_workspace_write.network_access=true",
      "thr_123",
    ]);
    expect(args).not.toContain("--sandbox");
  });

  it("resume never carries -C (rejected by exec resume)", () => {
    const args = buildCodexArgs({ resumeThreadId: "thr_123", cwd: "/proj", addDirs: ["/x"] });
    expect(args).not.toContain("-C");
  });

  it("serviceTier maps to quoted -c on both branches, default omits", () => {
    expect(buildCodexArgs({ serviceTier: "priority", sandboxMode: "read-only" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'service_tier="priority"',
    ]);
    expect(
      buildCodexArgs({
        serviceTier: "priority",
        resumeThreadId: "thr_123",
        sandboxMode: "read-only",
      }),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'service_tier="priority"',
      "thr_123",
    ]);
    expect(buildCodexArgs({ serviceTier: "default", sandboxMode: "read-only" })).not.toContain(
      "service_tier",
    );
  });

  it("disablePlugins adds --disable plugins via option or env", () => {
    const args = buildCodexArgs({ disablePlugins: true, sandboxMode: "read-only" });
    expect(args).toContain("--disable");
    expect(args).toContain("plugins");
    expect(buildCodexArgs({ sandboxMode: "read-only" })).not.toContain("--disable");
  });

  it("OD_CODEX_DISABLE_PLUGINS=1 triggers plugin disable without the option", () => {
    vi.stubEnv("OD_CODEX_DISABLE_PLUGINS", "1");
    try {
      expect(buildCodexArgs({ sandboxMode: "read-only" })).toContain("--disable");
    } finally {
      vi.unstubAllEnvs();
    }
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
          "reasoning_delta",
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

  it("reasoning item.completed → reasoning_delta (never tool events)", () => {
    // Shape per codex exec_events.rs: ReasoningItem { text } on completed.
    // Previously this surfaced as tool_started/tool_finished named
    // "reasoning" — thinking misfiled as tool calls.
    const p = new CodexParser();
    const line = `{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"**Reviewing** the plan"}}\n`;
    const evs = [...p.parse(enc(line)), ...p.flush()];
    expect(evs).toEqual([{ type: "reasoning_delta", text: "**Reviewing** the plan" }]);
  });

  it("reasoning item.started is ignored; empty reasoning is dropped", () => {
    const p = new CodexParser();
    const started = `{"type":"item.started","item":{"id":"item_2","type":"reasoning"}}\n`;
    const empty = `{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":""}}\n`;
    expect([...p.parse(enc(started)), ...p.parse(enc(empty)), ...p.flush()]).toEqual([]);
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
