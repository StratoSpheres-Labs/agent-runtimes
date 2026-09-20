import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLaunch } from "../src/discovery/launch.js";

function makeShim(dir: string): string {
  const scriptRel = join("node_modules", "pkg", "bin", "agent.js");
  mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
  const script = join(dir, scriptRel);
  writeFileSync(script, "// stub");
  const shim = join(dir, "agent.cmd");
  writeFileSync(shim, `@ECHO off\nnode  "%dp0%${scriptRel}" %*\n`);
  return shim;
}

describe("resolveLaunch", () => {
  it("runs win32 .cmd shims via host node", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-launch-"));
    try {
      const shim = makeShim(dir);
      const launch = resolveLaunch(shim, "win32");
      expect(launch.command).toBe(process.execPath);
      expect(launch.prependArgs).toHaveLength(1);
      expect(launch.prependArgs[0]?.endsWith("agent.js")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes native binaries through untouched on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(resolveLaunch("/usr/local/bin/agent", platform)).toEqual({
        command: "/usr/local/bin/agent",
        prependArgs: [],
      });
      expect(resolveLaunch("C:\\tools\\agent.exe", platform)).toEqual({
        command: "C:\\tools\\agent.exe",
        prependArgs: [],
      });
    }
  });

  it("ignores .cmd shims off win32 (shebang territory)", () => {
    const shim = "C:\\tools\\agent.cmd";
    expect(resolveLaunch(shim, "linux")).toEqual({ command: shim, prependArgs: [] });
  });

  it("falls back to the raw path when no shim target resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-launch-"));
    try {
      const shim = join(dir, "ghost.cmd");
      writeFileSync(shim, "@ECHO off\nnode missing.js %*\n");
      expect(resolveLaunch(shim, "win32")).toEqual({ command: shim, prependArgs: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
