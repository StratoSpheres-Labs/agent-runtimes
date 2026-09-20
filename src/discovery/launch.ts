import { resolveShimTarget } from "./npm-shim.js";

export interface ResolvedLaunch {
  /** Binary to spawn — host node when the install is a shim, else the executable itself. */
  command: string;
  /** Argv prefix before the agent args (the resolved script when shimmed). */
  prependArgs: string[];
  /** Extra env to merge (e.g. harvested NODE_PATH); undefined means inherit. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve how to actually spawn a CLI executable.
 * npm-shim-only installs (win32, no native exe) cannot run via
 * `spawn(shim, {shell:false})` (EINVAL), so the shim is resolved to its node
 * script and launched with the host node — the same pattern the `.cmd`
 * itself uses (`node x.js ...`). Shims forwarding to a native binary run
 * that binary directly. Real binaries pass through untouched.
 * Agent-agnostic: every adapter (and the core version probe) goes through
 * here instead of each reinventing shim handling (Rule 7).
 */
export function resolveLaunch(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedLaunch {
  if (platform === "win32") {
    const shim = resolveShimTarget(executable, platform);
    if (shim?.binary) {
      return { command: shim.binary, prependArgs: [] };
    }
    if (shim?.script) {
      return {
        command: process.execPath,
        prependArgs: [shim.script],
        env: shim.env ? { ...process.env, ...shim.env } : undefined,
      };
    }
  }
  return { command: executable, prependArgs: [] };
}
