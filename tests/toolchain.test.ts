import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { userToolchainBinDirs, toolchainProbePaths } from "../src/discovery/toolchain.js";
import { buildAgentEnv } from "../src/discovery/env.js";

function fakeHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-toolchain-"));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("userToolchainBinDirs", () => {
  it("finds posix user bins and nvm versions, skips the missing", () => {
    const { dir, cleanup } = fakeHome();
    try {
      mkdirSync(join(dir, ".local", "bin"), { recursive: true });
      mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
      mkdirSync(join(dir, ".nvm", "versions", "node", "v22.0.0", "bin"), { recursive: true });
      const dirs = userToolchainBinDirs({ home: dir, platform: "linux", env: {} });
      expect(dirs).toContain(join(dir, ".local", "bin"));
      expect(dirs).toContain(join(dir, ".bun", "bin"));
      expect(dirs).toContain(join(dir, ".nvm", "versions", "node", "v22.0.0", "bin"));
      for (const d of dirs) expect(existsSync(d)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("finds win32 npm/bun locations from env", () => {
    const { dir, cleanup } = fakeHome();
    try {
      mkdirSync(join(dir, "npm"), { recursive: true });
      mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
      const env = { APPDATA: dir, LOCALAPPDATA: dir, USERPROFILE: dir };
      const dirs = userToolchainBinDirs({ home: dir, platform: "win32", env });
      expect(dirs).toContain(join(dir, "npm"));
      expect(dirs).toContain(join(dir, ".bun", "bin"));
    } finally {
      cleanup();
    }
  });

  it("returns [] when nothing exists (win32 branch is fully determined)", () => {
    const { dir, cleanup } = fakeHome();
    try {
      expect(userToolchainBinDirs({ home: dir, platform: "win32", env: {} })).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("toolchainProbePaths", () => {
  it("expands PATHEXT on win32 with .exe first", () => {
    const { dir, cleanup } = fakeHome();
    try {
      mkdirSync(join(dir, "npm"), { recursive: true });
      const paths = toolchainProbePaths("agent", {
        home: dir,
        platform: "win32",
        env: { APPDATA: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      });
      expect(paths[0]).toBe(join(dir, "npm", "agent.exe"));
      expect(paths).toContain(join(dir, "npm", "agent.cmd"));
    } finally {
      cleanup();
    }
  });

  it("is a bare name on posix", () => {
    const { dir, cleanup } = fakeHome();
    try {
      mkdirSync(join(dir, ".local", "bin"), { recursive: true });
      expect(toolchainProbePaths("agent", { home: dir, platform: "linux", env: {} })).toContain(
        join(dir, ".local", "bin", "agent"),
      );
    } finally {
      cleanup();
    }
  });
});

describe("buildAgentEnv PATH symmetry", () => {
  it("appends the missing toolchain dir without reordering or dupes", () => {
    const { dir, cleanup } = fakeHome();
    try {
      mkdirSync(join(dir, "npm"), { recursive: true });
      mkdirSync(join(dir, ".local", "bin"), { recursive: true });
      const base = {
        PATH: `/usr/bin${delimiter}/usr/sbin`,
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: dir,
        LOCALAPPDATA: dir,
      };
      const out = buildAgentEnv("opencode", base);
      const parts = (out["PATH"] ?? "").split(delimiter);
      // Original order preserved up front.
      expect(parts[0]).toBe("/usr/bin");
      expect(parts[1]).toBe("/usr/sbin");
      // Exactly one toolchain dir appended, per real platform branch.
      const expected = process.platform === "win32" ? join(dir, "npm") : join(dir, ".local", "bin");
      expect(parts).toContain(expected);
      // No duplicates and idempotent on re-entry.
      expect(new Set(parts.map((p) => p.toLowerCase())).size).toBe(parts.length);
      const again = buildAgentEnv("opencode", { ...base, PATH: out["PATH"] });
      expect(again["PATH"]).toBe(out["PATH"]);
    } finally {
      cleanup();
    }
  });
});
