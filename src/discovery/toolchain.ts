import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolchainOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * User-level toolchain bin directories beyond PATH.
 * GUI-launched hosts (macOS `.app`, Linux `.desktop`, Electron) start with a
 * minimal PATH, so agent binaries installed via Homebrew, bun, npm globals,
 * or node version managers are invisible to plain PATH resolution — and a
 * binary that resolves can still fail to *execute* when its shebang
 * interpreter (e.g. `#!/usr/bin/env bun`) lives in one of these dirs.
 * Keep resolution and spawn PATH symmetric: `findExecutable` searches these
 * dirs and `buildAgentEnv` appends the missing ones to the child PATH.
 * Pure (home/platform/env injectable) for tests. Only existing dirs return.
 */
export function userToolchainBinDirs(options: ToolchainOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env["HOME"] ?? env["USERPROFILE"] ?? homedir();
  const out: string[] = [];
  const push = (dir: string | undefined): void => {
    if (!dir) return;
    try {
      if (existsSync(dir) && !out.includes(dir)) out.push(dir);
    } catch {
      // Unreadable path — skip, never throw from discovery.
    }
  };

  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData) push(join(appData, "npm"));
    const localAppData = env["LOCALAPPDATA"];
    if (localAppData) push(join(localAppData, "Programs", "bun", "bin"));
    if (home) push(join(home, ".bun", "bin"));
    return out;
  }

  // POSIX: Homebrew (Apple Silicon + Intel), XDG user bins, bun.
  push("/opt/homebrew/bin");
  push("/usr/local/bin");
  if (home) {
    push(join(home, ".local", "bin"));
    push(join(home, ".bun", "bin"));
    // nvm: ~/.nvm/versions/node/v*/bin (every installed version).
    const nvmVersions = join(home, ".nvm", "versions", "node");
    let versions: string[] = [];
    try {
      versions = readdirSync(nvmVersions).sort();
    } catch {
      versions = [];
    }
    for (const v of versions) {
      push(join(nvmVersions, v, "bin"));
    }
  }
  return out;
}

/**
 * File paths to probe for `command` inside toolchain dirs (PATHEXT expanded
 * on win32). Feeds `findExecutable` candidates alongside PATH hits.
 */
export function toolchainProbePaths(command: string, options: ToolchainOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const exts =
    platform === "win32"
      ? Array.from(
          new Set([
            "",
            ".exe",
            ".cmd",
            ...((options.env ?? process.env)["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";"),
          ]),
        )
      : [""];
  const out: string[] = [];
  for (const dir of userToolchainBinDirs(options)) {
    for (const ext of exts) {
      const candidate = ext ? `${command}${ext}` : command;
      const full = join(dir, candidate);
      const dup = out.some((p) =>
        platform === "win32" ? p.toLowerCase() === full.toLowerCase() : p === full,
      );
      if (dup) continue;
      // Prefer .exe over .cmd over bare on win32 (matches orderWindowsHits).
      out.push(full);
    }
  }
  if (platform === "win32") {
    const rank = (p: string): number => {
      const l = p.toLowerCase();
      if (l.endsWith(".exe")) return 0;
      if (l.endsWith(".cmd") || l.endsWith(".bat")) return 1;
      return 2;
    };
    out.sort((a, b) => rank(a) - rank(b));
  }
  return out;
}
