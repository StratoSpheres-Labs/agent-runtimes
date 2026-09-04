import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShimTarget } from "../src/discovery/npm-shim.js";

// Fixtures use join()-built (native-separator) paths and pass the platform
// explicitly, so these tests are hermetic on every OS.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agent-runtimes-shim-"));
}

describe("resolveShimTarget", () => {
  it("returns null off win32", () => {
    expect(resolveShimTarget("C:\\x\\codex.cmd", "linux")).toBeNull();
    expect(resolveShimTarget("C:\\x\\codex.cmd", "darwin")).toBeNull();
  });

  it("returns null for missing files and non-shim suffixes", () => {
    expect(resolveShimTarget(join(tmpdir(), "nope", "x.cmd"), "win32")).toBeNull();
    const dir = scratch();
    try {
      const txt = join(dir, "note.txt");
      writeFileSync(txt, "hello");
      expect(resolveShimTarget(txt, "win32")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves npm-style shims to the node script (no extra env)", () => {
    const dir = scratch();
    try {
      const scriptRel = join("node_modules", "@openai", "codex", "bin", "codex.js");
      mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
      writeFileSync(join(dir, scriptRel), "// stub");
      const shim = join(dir, "codex.cmd");
      writeFileSync(shim, `@ECHO off\nnode  "%dp0%${scriptRel}" %*\n`);
      const got = resolveShimTarget(shim, "win32");
      expect(got?.script).toBe(join(dir, scriptRel));
      expect(got?.env).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("harvests NODE_PATH from pnpm-style shims", () => {
    const dir = scratch();
    try {
      const scriptRel = join("global", "5", "tool", "cli.js");
      const storeRel = join("global", "5", "tool", "node_modules");
      mkdirSync(join(dir, "global", "5", "tool"), { recursive: true });
      writeFileSync(join(dir, scriptRel), "// stub");
      const shim = join(dir, "tool.cmd");
      writeFileSync(
        shim,
        `@SETLOCAL\n@IF NOT DEFINED NODE_PATH (\n  @SET "NODE_PATH=%~dp0\\${storeRel}"\n)\n` +
          `node  "%~dp0\\${scriptRel}" %*\n`,
      );
      const got = resolveShimTarget(shim, "win32");
      expect(got?.script).toBe(join(dir, scriptRel));
      expect(got?.env).toEqual({ NODE_PATH: join(dir, storeRel) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
