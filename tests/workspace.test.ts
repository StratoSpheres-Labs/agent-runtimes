import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  normalizeWorkspaceAllowedPaths,
} from "../src/definition/workspace.js";
import { capabilitiesFromHelp } from "../src/discovery/capabilities.js";
import { buildClaudeArgs } from "../runtimes/claude/definition.js";
import { buildCodexArgs } from "../runtimes/codex/definition.js";
import { ClaudeSession } from "../runtimes/claude/session.js";
import { CodexSession } from "../runtimes/codex/session.js";
import type { RuntimeCapabilities } from "../src/definition/capability.js";

const base: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: false,
  workspace: false,
};

describe("normalizeWorkspaceAllowedPaths", () => {
  it("resolves relative paths against cwd, dedupes, filters empties", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const a = resolve(cwd, "a");
      const out = normalizeWorkspaceAllowedPaths(["a", "a", " ", a], cwd);
      expect(out).toEqual([a]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves absolute paths untouched, empty input returns empty", () => {
    expect(normalizeWorkspaceAllowedPaths(undefined, undefined)).toEqual([]);
    expect(normalizeWorkspaceAllowedPaths([], "/tmp")).toEqual([]);
  });
});

describe("capabilitiesFromHelp workspace gating", () => {
  it("enables workspace when help contains --add-dir or --sandbox or -C", () => {
    expect(capabilitiesFromHelp(base, { "--add-dir": true }).workspace).toBe(true);
    expect(capabilitiesFromHelp(base, { "--sandbox": true }).workspace).toBe(true);
    expect(capabilitiesFromHelp(base, { "-C": true }).workspace).toBe(true);
    expect(capabilitiesFromHelp(base, { "--permission-mode": true }).workspace).toBe(true);
    expect(capabilitiesFromHelp(base, { "--dangerously-skip-permissions": true }).workspace).toBe(true);
    expect(capabilitiesFromHelp(base, {}).workspace).toBe(false);
  });
});

describe("buildArgs workspace mapping", () => {
  it("claude addDirs → --add-dir, permissionMode → --permission-mode", () => {
    expect(buildClaudeArgs({ addDirs: ["/a", "/b"], permissionMode: "plan" })).toEqual(
      expect.arrayContaining(["--add-dir", "/a", "--add-dir", "/b", "--permission-mode", "plan"]),
    );
  });

  it("claude dangerouslySkipPermissions → --dangerously-skip-permissions (open-design bypass alias)", () => {
    expect(buildClaudeArgs({ dangerouslySkipPermissions: true })).toContain("--dangerously-skip-permissions");
    expect(buildClaudeArgs({})).not.toContain("--dangerously-skip-permissions");
  });

  it("codex addDirs → -C, sandboxMode → --sandbox (new) and -c on resume", () => {
    expect(buildCodexArgs({ addDirs: ["/a"], sandboxMode: "workspace-write" })).toEqual(
      expect.arrayContaining(["-C", "/a", "--sandbox", "workspace-write"]),
    );
    expect(
      buildCodexArgs({ resumeThreadId: "thr_1", sandboxMode: "workspace-write" }),
    ).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="workspace-write"', "thr_1"]));
    expect(buildCodexArgs({ resumeThreadId: "thr_1", sandboxMode: "workspace-write" })).not.toContain(
      "--sandbox",
    );
  });
});

describe("sessions accept workspace without leaking flags", () => {
  it("ClaudeSession and CodexSession close cleanly with workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ws-sess-"));
    try {
      const claude = new ClaudeSession({
        id: "ws_claude",
        command: process.execPath,
        cwd,
        workspace: { allowedPaths: ["./extra"], permissionMode: "default" },
      });
      await claude.close();
      const codex = new CodexSession({
        id: "ws_codex",
        command: process.execPath,
        cwd,
        workspace: { allowedPaths: [cwd], sandboxMode: "read-only" },
      });
      await codex.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
