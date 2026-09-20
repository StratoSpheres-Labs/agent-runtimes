import { describe, expect, it, vi } from "vitest";
import { basename, delimiter, join } from "node:path";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  agentSearchDirs,
  findExecutable,
  forgetUnusableExecutables,
  isExecutableFile,
  resolveExtraProbePaths,
} from "../src/discovery/executable.js";
import { codexDefinition } from "../runtimes/codex/definition.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";

describe("agentSearchDirs", () => {
  it("lists de-duplicated PATH entries without spawning", () => {
    const dirs = agentSearchDirs();
    const expected = (process.env["PATH"] ?? "")
      .split(delimiter)
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of expected.slice(0, 5)) {
      expect(dirs).toContain(d);
    }
    expect(new Set(dirs.map((d) => d.toLowerCase())).size).toBe(dirs.length);
  });
});

describe("unusable-executable memory", () => {
  it("remembers broken shims until forgotten (win32 shim mechanics)", async () => {
    // Needs real `.cmd` semantics: skipped elsewhere, no behavior change.
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-unusable-"));
    const scriptRel = join("vendor", "ghost.js");
    const shim = join(dir, "ghostcli.cmd");
    // Shim points at a not-yet-existing target → broken.
    writeFileSync(shim, `@ECHO off\nnode  "%dp0%${scriptRel}" %*\n`);
    // Prepend (never replace): the resolver itself spawns `where`, which
    // lives in System32 and must stay resolvable.
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);
    try {
      await expect(findExecutable("ghostcli")).resolves.toBeNull();
      // Repair the target: still skipped while remembered.
      mkdirSync(join(dir, "vendor"), { recursive: true });
      writeFileSync(join(dir, scriptRel), "// now exists");
      await expect(findExecutable("ghostcli")).resolves.toBeNull();
      // Forgetting rescans and finds the repaired shim. Compared by trailing
      // segments: `where` returns the long form while tmpdir hands out 8.3
      // short names — same file, different ancestor strings (Windows artifact).
      forgetUnusableExecutables("ghostcli");
      const found = await findExecutable("ghostcli");
      expect(found?.toLowerCase().endsWith(join(basename(dir), "ghostcli.cmd").toLowerCase())).toBe(
        true,
      );
    } finally {
      vi.unstubAllEnvs();
      forgetUnusableExecutables("ghostcli");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isExecutableFile", () => {
  it("accepts runnable files, rejects wrong extensions and dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-exec-"));
    try {
      const exe = join(dir, "tool.exe");
      const bare = join(dir, "tool");
      const text = join(dir, "tool.txt");
      writeFileSync(exe, "x");
      writeFileSync(bare, "x");
      writeFileSync(text, "x");
      // Fresh files lack +x on POSIX — set it, like the bit test below does.
      if (process.platform !== "win32") chmodSync(exe, 0o755);
      expect(isExecutableFile(exe)).toBe(true);
      expect(isExecutableFile(dir)).toBe(false);
      expect(isExecutableFile(join(dir, "missing"))).toBe(false);
      if (process.platform === "win32") {
        expect(isExecutableFile(text)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes per platform: bare rejected on win32, batch rejected on posix", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-exec-plat-"));
    try {
      const exe = join(dir, "tool.exe");
      const cmd = join(dir, "tool.cmd");
      const ps1 = join(dir, "tool.ps1");
      const bare = join(dir, "tool");
      writeFileSync(exe, "x");
      writeFileSync(cmd, "x");
      writeFileSync(ps1, "x");
      writeFileSync(bare, "x");
      // win32: PATHEXT only — a bare POSIX shim is not a candidate here.
      expect(isExecutableFile(exe, "win32")).toBe(true);
      expect(isExecutableFile(cmd, "win32")).toBe(true);
      expect(isExecutableFile(bare, "win32")).toBe(false);
      // posix: batch suffixes are dead weight even with the +x bit set.
      expect(isExecutableFile(cmd, "linux")).toBe(false);
      expect(isExecutableFile(ps1, "linux")).toBe(false);
      // posix bare/.exe files follow the executable bit (effective where
      // chmod works); .exe stays fail-open for misnamed native binaries.
      if (process.platform !== "win32") {
        for (const f of [bare, exe]) chmodSync(f, 0o755);
        expect(isExecutableFile(bare, "linux")).toBe(true);
        expect(isExecutableFile(exe, "linux")).toBe(true);
        chmodSync(bare, 0o644);
        expect(isExecutableFile(bare, "linux")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors the posix executable bit", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-exec-"));
    try {
      const script = join(dir, "run.sh");
      writeFileSync(script, "#!/bin/sh\n");
      chmodSync(script, 0o644);
      expect(isExecutableFile(script)).toBe(false);
      chmodSync(script, 0o755);
      expect(isExecutableFile(script)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveExtraProbePaths", () => {
  it("expands ~, passes absolute through, ignores the rest", () => {
    expect(resolveExtraProbePaths(undefined, "C:\\home")).toEqual([]);
    expect(resolveExtraProbePaths([], "C:\\home")).toEqual([]);
    expect(
      resolveExtraProbePaths(
        [
          "~/Applications/Codex.app/Contents/Resources/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
          "relative/nope",
          "  ",
        ],
        "C:\\Users\\someone",
      ),
    ).toEqual([
      join("C:\\Users\\someone", "Applications", "Codex.app", "Contents", "Resources", "codex"),
      "/Applications/Codex.app/Contents/Resources/codex",
    ]);
  });

  it("codex declares the macOS app bundle, opencode its bundle paths", () => {
    const codex = codexDefinition.executable.extraProbePaths ?? [];
    expect(codex.some((p) => p.includes("Codex.app"))).toBe(true);
    const opencode = opencodeDefinition.executable.extraProbePaths ?? [];
    expect(opencode.some((p) => p.includes("opencode.exe"))).toBe(true);
  });
});

describe("findExecutable with definition extras", () => {
  it("finds shim-only installs with zero PATH hits", async () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-extras-"));
    const home = join(dir, "home");
    const scriptRel = join("vendor", "ghost2.js");
    mkdirSync(join(home, "AppData", "Roaming", "testbin", "vendor"), { recursive: true });
    writeFileSync(join(home, "AppData", "Roaming", "testbin", "vendor", "ghost2.js"), "// stub");
    writeFileSync(
      join(home, "AppData", "Roaming", "testbin", "ghost2.cmd"),
      `@ECHO off\nnode  "%dp0%${scriptRel}" %*\n`,
    );
    // Prepend (never replace): `where` itself lives in System32.
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);
    // Home override so `~` expansion lands in the sandbox, not the real home.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      const found = await findExecutable("ghost2", [], ["~/AppData/Roaming/testbin/ghost2.cmd"]);
      expect(found?.toLowerCase().endsWith(join("testbin", "ghost2.cmd").toLowerCase())).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      forgetUnusableExecutables("ghost2");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
