import { resolveShimTarget } from "./npm-shim.js";
import { resolveLaunch } from "./launch.js";
import { isExecutableFile, isInvocable, resolveExtraProbePaths, whichAll } from "./executable.js";
import { toolchainProbePaths } from "./toolchain.js";
import { compareSemver, parseSemver, probeVersion } from "./version.js";

/**
 * Where one copy of a CLI came from, inferred from its path (shim target
 * preferred, shim itself as fallback). Honest over clever: anything that
 * doesn't match a known layout is `"unknown"`, and distro/system paths
 * are `"native"`. Pure — no spawning.
 */
export type InstallManager =
  | "npm"
  | "pnpm"
  | "bun"
  | "yarn"
  | "winget"
  | "scoop"
  | "choco"
  | "volta"
  | "nvm"
  | "fnm"
  | "mise"
  | "asdf"
  | "brew"
  | "native"
  | "unknown";

export interface InstalledCopy {
  /** Dedupe key: shim-resolved real target, or the path itself when direct. */
  binary: string;
  /** PATH hits (shims included) pointing at this binary, PATH order. */
  shims: string[];
  /** Live `--version` probe via the resolved launch; null when unprobable. */
  version: string | null;
  /** Inferred installer; `"unknown"` when the layout says nothing. */
  manager: InstallManager;
  /** At least the spawn probe passed (version may still be unparseable). */
  invocable: boolean;
  /** The copy `findExecutable` would pick (newest version, first on ties). */
  selected: boolean;
}

export interface InstallSearchOptions {
  /** Extra absolute probe paths (same meaning as in `findExecutable`). */
  extras?: readonly string[];
  /** Args printing the version (default `["--version"]`). */
  versionArgs?: string[];
  /** Override for hermetic tests. */
  platform?: NodeJS.Platform;
}

/**
 * Infer the installer from a file path. Segment matching (never bare
 * substring): `npm` must appear as `\npm\`, so a pnpm store path full of
 * `node_modules` never misfires. Prefer calling with the shim *target*;
 * fall back to the shim path itself.
 */
export function inferInstallManager(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): InstallManager {
  const p = platform === "win32" ? filePath.toLowerCase() : filePath;
  const has = (seg: string): boolean => p.includes(seg);
  if (platform === "win32") {
    if (has("\\pnpm\\") || has("\\.pnpm\\")) return "pnpm";
    if (has("\\appdata\\roaming\\npm\\") || has("\\npm\\node_modules\\")) return "npm";
    if (has("\\.bun\\bin\\") || has("\\programs\\bun\\bin\\")) return "bun";
    if (has("\\winget\\packages\\") || has("\\microsoft\\winget\\")) return "winget";
    if (has("\\scoop\\")) return "scoop";
    if (has("chocolatey")) return "choco";
    if (has("\\.volta\\")) return "volta";
    if (has("\\.fnm\\")) return "fnm";
    if (has("mise\\shims") || has("\\.local\\share\\mise\\")) return "mise";
    if (has("\\.asdf\\")) return "asdf";
    if (has("\\yarn\\bin\\")) return "yarn";
    if (has("\\.nvm\\")) return "nvm";
    // Node-bundled yarn (`...\nodejs\yarn.cmd`) has no \yarn\bin segment.
    if (has("\\yarn")) return "yarn";
    if (/^[a-z]:\\program files/i.test(filePath) && /\.exe$/i.test(filePath)) return "native";
    return "unknown";
  }
  if (has("/opt/homebrew/") || has("/homebrew/") || has("/Cellar/")) return "brew";
  if (has("/.bun/bin/")) return "bun";
  if (has("/.volta/")) return "volta";
  if (has("/.nvm/")) return "nvm";
  if (has("/.fnm/")) return "fnm";
  if (has("/mise/shims/") || has("/.local/share/mise/")) return "mise";
  if (has("/.asdf/")) return "asdf";
  if (has("/yarn/bin/")) return "yarn";
  if (has("/usr/bin/") || p.startsWith("/bin/") || has("/usr/sbin/")) return "native";
  return "unknown";
}

/**
 * List every installed copy of a CLI: PATH hits (+ aliases, extras,
 * toolchain dirs), grouped by resolved binary, each live version-probed.
 * Diagnostic companion to `findExecutable` (which returns only the winner):
 * same gathering rules, same launch resolution, no behavior change there.
 * PATH order is preserved; `selected` marks what `findExecutable` picks.
 */
export async function findAllInstalls(
  command: string,
  aliases: string[] = [],
  options: InstallSearchOptions = {},
): Promise<InstalledCopy[]> {
  const platform = options.platform ?? process.platform;
  const versionArgs = options.versionArgs ?? ["--version"];
  const seen = new Set<string>();
  const hits: string[] = [];
  const push = (path: string): void => {
    const key = platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    if (isExecutableFile(path)) hits.push(path);
  };
  for (const candidate of [command, ...aliases]) {
    for (const hit of await whichAll(candidate)) push(hit);
  }
  for (const extra of resolveExtraProbePaths(options.extras)) push(extra);
  for (const tool of toolchainProbePaths(command)) push(tool);

  // Group PATH hits (shims included) by resolved binary. Each group keeps
  // its first hit (PATH order) for probing; groups are never empty.
  const groups = new Map<string, { first: string; shims: string[] }>();
  for (const hit of hits) {
    const binary = resolveBinary(hit, platform);
    const key = platform === "win32" ? binary.toLowerCase() : binary;
    const group = groups.get(key);
    if (group) group.shims.push(hit);
    else groups.set(key, { first: hit, shims: [hit] });
  }

  const copies: InstalledCopy[] = [];
  for (const { first, shims } of groups.values()) {
    const binary = resolveBinary(first, platform);
    const launch = resolveLaunch(first, platform);
    const version = await probeVersion(
      launch.command,
      [...launch.prependArgs, ...versionArgs],
      launch.env,
    );
    const invocable = version !== null || (await isInvocable(first));
    const fromTarget = inferInstallManager(binary, platform);
    copies.push({
      binary,
      shims,
      version,
      manager: fromTarget !== "unknown" ? fromTarget : inferInstallManager(first, platform),
      invocable,
      selected: false,
    });
  }

  // Same winner rule as findExecutable: newest probed version; ties keep
  // PATH order; with no versions, the first invocable copy wins.
  let best: InstalledCopy | null = null;
  let bestVer: ReturnType<typeof parseSemver> = null;
  for (const copy of copies) {
    if (!copy.invocable || copy.version === null) continue;
    const ver = parseSemver(copy.version);
    if (best === null || (ver && bestVer && compareSemver(ver, bestVer) > 0)) {
      best = copy;
      bestVer = ver;
    } else if (bestVer === null && ver) {
      best = copy;
      bestVer = ver;
    }
  }
  if (!best) best = copies.find((c) => c.invocable) ?? null;
  if (best) best.selected = true;
  return copies;
}

/** Shim-resolved real target (binary or script), else the path itself. */
function resolveBinary(hit: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const shim = resolveShimTarget(hit, platform);
    if (shim?.binary) return shim.binary;
    if (shim?.script) return shim.script;
  }
  return hit;
}
