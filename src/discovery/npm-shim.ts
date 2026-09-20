import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize, sep } from "node:path";

export interface ShimLaunch {
  /**
   * Resolved node script target (existsSync-verified). Spawn via node with
   * this as argv[0]. Absent when the shim forwards to a native binary.
   */
  script?: string;
  /**
   * Resolved native binary target (existsSync-verified). Spawn directly —
   * no node, no shell. Newer CLIs (e.g. claude-code 2.1.276) ship a real
   * `.exe` that the manager shim execs instead of `node *.js`.
   */
  binary?: string;
  /**
   * Extra env harvested from the shim (e.g. pnpm `NODE_PATH`). Merging is
   * the caller's job — never pass this object alone (the child would lose
   * PATH/SystemRoot). Absent when the shim needs nothing beyond inheritance.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve a Windows npm/pnpm `.cmd`/`.bat` shim to what it actually runs.
 * Classic shims wrap `node <pkg>/bin/*.js`; newer ones forward to a native
 * binary (`<pkg>/bin/*.exe`). Raw `spawn(shim, {shell:false})` fails with
 * EINVAL because CreateProcess cannot execute batch files.
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
  const quoted = (ext: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`"([^"]+\\.${ext})"`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cand = m[1] ?? "";
      if (cand && !out.includes(cand)) out.push(expand(cand));
    }
    return out;
  };
  // Node-script shims keep the historical shape (script + harvested env).
  const script = quoted("js").find((c) => existsSync(c));
  if (script) {
    const env = harvestNodePath(text, expand);
    if (env) return { script, env };
    return { script };
  }
  // Native-binary shims (no .js target): spawn the exe directly.
  const binary = quoted("exe").find((c) => existsSync(c));
  if (binary) return { binary };
  return null;
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
