import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize, sep } from "node:path";

export interface ShimLaunch {
  /** Resolved node script target (existsSync-verified). Spawn via node with this as argv[0]. */
  script: string;
  /**
   * Extra env harvested from the shim (e.g. pnpm `NODE_PATH`). Merging is
   * the caller's job — never pass this object alone (the child would lose
   * PATH/SystemRoot). Absent when the shim needs nothing beyond inheritance.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve a Windows npm/pnpm `.cmd`/`.bat` shim to its node script target.
 * npm shims wrap `node <pkg>/bin/*.js`; raw `spawn(shim, {shell:false})`
 * fails with EINVAL because CreateProcess cannot execute batch files.
 * Win32-only (POSIX shims execute via shebang); returns null when the
 * platform, suffix, content, or target doesn't cooperate.
 */
export function resolveShimTarget(
  shimPath: string,
  platform: NodeJS.Platform = process.platform,
): ShimLaunch | null {
  if (platform !== "win32") return null;
  if (!/\.(cmd|bat)$/i.test(shimPath)) return null;
  if (!existsSync(shimPath)) return null;
  let text: string;
  try {
    text = readFileSync(shimPath, "utf-8");
  } catch {
    return null;
  }
  const dir = dirname(shimPath);
  const expand = (s: string): string => normalize(expandShimVars(s, dir));
  const candidates: string[] = [];
  const re = /"([^"]+\.js)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cand = m[1] ?? "";
    if (cand && !candidates.includes(cand)) candidates.push(expand(cand));
  }
  const script = candidates.find((c) => existsSync(c));
  if (!script) return null;
  const env = harvestNodePath(text, expand);
  if (env) return { script, env };
  return { script };
}

function expandShimVars(value: string, dir: string): string {
  const withDp0 = value.replace(/%~dp0/gi, dir + sep).replace(/%dp0%/gi, dir + sep);
  return withDp0.replace(/%([^%]+)%/g, (full: string, name: string) => {
    return lookupEnv(name) ?? full;
  });
}

function lookupEnv(name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === upper) return process.env[key];
  }
  return undefined;
}

function harvestNodePath(
  text: string,
  expand: (s: string) => string,
): Record<string, string | undefined> | undefined {
  // First (IF-branch) match wins — deterministic, no inherited suffix.
  const m = /^[ \t]*@SET\s+"NODE_PATH=([^"]*)"/im.exec(text);
  if (!m?.[1]) return undefined;
  return { NODE_PATH: expand(m[1]) };
}
