import { compareSemver, parseSemver } from "./version.js";
import type { InstalledCopy } from "./installs.js";

/**
 * Update checks — npm registry only, by decision (pnpm/bun installs resolve
 * upstream through the same registry; winget/brew have no cheap per-package
 * query and stay unchecked). Network-slow (seconds per package): the doctor
 * Version row calls this on every run, results are cached for an hour, and
 * every failure mode yields "no suffix" rather than an error.
 */

export interface UpdateInfo {
  /** Which installed copy this concerns (matches an `InstalledCopy`). */
  binary: string;
  manager: InstalledCopy["manager"];
  installed: string;
  latest: string;
  updateAvailable: boolean;
}

/** Latest-version cache: one registry hit per package per hour. */
const LATEST_TTL_MS = 3_600_000;
const latestCache = new Map<string, { at: number; version: string | null }>();

/**
 * Pure comparison: true only when both sides parse as semver and latest is
 * strictly newer. Nightly hashes, `latest` tags, and garbage fail open to
 * false — never nag on what can't be ordered.
 */
export function updateAvailable(installed: string, latest: string): boolean {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  return compareSemver(b, a) > 0;
}

export interface FetchLatestOptions {
  /** Registry base (default `https://registry.npmjs.org`) — injectable for hermetic tests. */
  registry?: string;
  /** Per-request timeout ms (default 15_000). */
  timeoutMs?: number;
}

/**
 * Latest published version of an npm package, read straight from the
 * registry (`GET <registry>/<pkg>/latest` → `{version}`). Direct HTTPS —
 * deliberately not `npm view`: the npm CLI itself is a win32 `.cmd` shim
 * that cannot spawn with shell:false (and nvm-style stubs resolve to env
 * vars, not paths). Null when offline, timed out, or the name doesn't
 * exist. Never throws. Note: corporate HTTP(S)_PROXY envs are not applied
 * (undici default) — proxied machines stay `unknown` rather than failing.
 */
export async function fetchLatestVersion(
  npmPackage: string,
  options: FetchLatestOptions = {},
): Promise<string | null> {
  const key = `${options.registry ?? ""}\0${npmPackage}`;
  const cached = latestCache.get(key);
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version;
  const version = await fetchLatestUncached(npmPackage, options);
  latestCache.set(key, { at: Date.now(), version });
  return version;
}

async function fetchLatestUncached(
  npmPackage: string,
  options: FetchLatestOptions,
): Promise<string | null> {
  const base = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const url = `${base}/${npmPackage
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}/latest`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0 ? body.version : null;
  } catch {
    return null;
  }
}

/** Clear the latest-version cache (tests, or a forced recheck). */
export function clearLatestCache(): void {
  latestCache.clear();
}

/**
 * Check installed copies against the registry. Returns null when there is
 * nothing to say: no `registryId` (not checkable), registry unreachable,
 * or no versioned copies. Null is not an error — callers render no row.
 */
export async function checkForUpdates(
  copies: InstalledCopy[],
  registryId?: string,
  fetchOptions: FetchLatestOptions = {},
): Promise<UpdateInfo[] | null> {
  if (!registryId) return null;
  const latest = await fetchLatestVersion(registryId, fetchOptions);
  if (!latest) return null;
  const out: UpdateInfo[] = [];
  for (const copy of copies) {
    if (!copy.invocable || !copy.version) continue;
    out.push({
      binary: copy.binary,
      manager: copy.manager,
      installed: copy.version,
      latest,
      updateAvailable: updateAvailable(copy.version, latest),
    });
  }
  return out;
}
