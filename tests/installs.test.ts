import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAllInstalls, inferInstallManager } from "../src/discovery/installs.js";

describe("inferInstallManager", () => {
  const cases: Array<[string, "win32" | "linux", ReturnType<typeof inferInstallManager>]> = [
    ["C:\\Users\\u\\AppData\\Local\\pnpm\\claude.CMD", "win32", "pnpm"],
    [
      "C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\x\\node_modules\\x\\bin\\x.exe",
      "win32",
      "pnpm",
    ],
    ["C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd", "win32", "npm"],
    ["C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\code\\bin\\code.exe", "win32", "npm"],
    ["C:\\Users\\u\\.bun\\bin\\opencode.exe", "win32", "bun"],
    ["C:\\WinGet\\Packages\\Anthropic.ClaudeCode__8weky\\claude.exe", "win32", "winget"],
    ["C:\\Users\\u\\scoop\\shims\\claude.exe", "win32", "scoop"],
    ["C:\\ProgramData\\chocolatey\\bin\\codex.exe", "win32", "choco"],
    ["C:\\Users\\u\\.volta\\bin\\node.exe", "win32", "volta"],
    ["C:\\Users\\u\\.fnm\\node-versions\\v22\\bin\\x.exe", "win32", "fnm"],
    ["C:\\Users\\u\\.local\\share\\mise\\shims\\x.exe", "win32", "mise"],
    ["C:\\Users\\u\\.asdf\\shims\\x.exe", "win32", "asdf"],
    ["C:\\Program Files\\nodejs\\yarn.cmd", "win32", "yarn"],
    ["C:\\Users\\u\\.nvm\\v22\\x.exe", "win32", "nvm"],
    ["C:\\Program Files\\Claude\\claude.exe", "win32", "native"],
    ["C:\\tools\\mystery\\tool.exe", "win32", "unknown"],
    ["/opt/homebrew/bin/codex", "linux", "brew"],
    ["/usr/local/Cellar/x/1.0/bin/y", "linux", "brew"],
    ["/home/u/.bun/bin/opencode", "linux", "bun"],
    ["/home/u/.volta/bin/node", "linux", "volta"],
    ["/home/u/.nvm/versions/node/v22/bin/node", "linux", "nvm"],
    ["/home/u/.local/share/mise/shims/x", "linux", "mise"],
    ["/home/u/.asdf/shims/x", "linux", "asdf"],
    ["/usr/bin/git", "linux", "native"],
    ["/home/u/.local/bin/tool", "linux", "unknown"],
    ["/home/u/bin/tool", "linux", "unknown"],
  ];
  for (const [path, platform, expected] of cases) {
    it(`${platform}: ${path} �?${expected}`, () => {
      expect(inferInstallManager(path, platform)).toBe(expected);
    });
  }
});

describe("findAllInstalls (hermetic)", () => {
  it("win32: groups shims by binary, probes versions, marks selected", async () => {
    if (process.platform !== "win32") return;
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-installs-"));
    try {
      // Good copy: .cmd forwarding to a real binary (host node reports its version).
      const good = join(base, "good", "tool.cmd");
      mkdirSync(join(base, "good"), { recursive: true });
      writeFileSync(good, `@SETLOCAL\n@"${process.execPath}" --version %*\n`);
      // Broken copy: target missing �?distinct group, unprobable, unusable.
      const bad = join(base, "bad", "tool.cmd");
      mkdirSync(join(base, "bad"), { recursive: true });
      writeFileSync(bad, `@SETLOCAL\n@"${join(base, "bad", "nope.exe")}" %*\n`);
      const copies = await findAllInstalls("definitely-not-on-path-xyz", [], {
        extras: [good, bad],
      });
      expect(copies).toHaveLength(2);
      const first = copies[0];
      const second = copies[1];
      expect(first?.version).toMatch(/^v?\d+\.\d+\.\d+/);
      expect(first?.invocable).toBe(true);
      expect(first?.selected).toBe(true);
      // The good copy resolves to the host node binary — attribution follows
      // wherever node itself lives (self-consistent, not hardcoded).
      expect(first?.manager).toBe(inferInstallManager(process.execPath));
      expect(second?.version).toBeNull();
      expect(second?.invocable).toBe(false);
      expect(second?.selected).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("posix: newest version wins selected across extras", async () => {
    if (process.platform === "win32") return;
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-installs-"));
    try {
      const mk = (name: string, ver: string): string => {
        const p = join(base, name);
        writeFileSync(p, `#!/bin/sh\necho "tool ${ver}"\n`);
        chmodSync(p, 0o755);
        return p;
      };
      const oldBin = mk("tool-old", "1.0.0");
      const newBin = mk("tool-new", "9.9.9");
      const copies = await findAllInstalls("definitely-not-on-path-xyz", [], {
        extras: [oldBin, newBin],
      });
      expect(copies.map((c) => c.version)).toEqual(["tool 1.0.0", "tool 9.9.9"]);
      expect(copies.filter((c) => c.selected).map((c) => c.binary)).toEqual([newBin]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("DefaultRuntime.installs flows through the definition (live env tolerant)", async () => {
    const { DefaultRuntime } = await import("../src/core/runtime.js");
    const { opencodeDefinition } = await import("../runtimes/opencode/definition.js");
    const rt = new DefaultRuntime(opencodeDefinition);
    const copies = await rt.installs();
    expect(Array.isArray(copies)).toBe(true);
    for (const c of copies) {
      expect(typeof c.binary).toBe("string");
      expect(typeof c.manager).toBe("string");
    }
  });
});

describe("findAllInstalls (live, guarded)", () => {
  it("lists this machine's claude copies with a selected winner", async () => {
    const copies = await findAllInstalls("claude");
    if (copies.length === 0) return;
    expect(copies.filter((c) => c.selected)).toHaveLength(1);
    expect(copies.every((c) => c.shims.length > 0)).toBe(true);
  });
});
