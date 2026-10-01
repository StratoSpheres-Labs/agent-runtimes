import { runtimes } from "./runtimes.js";
import type { RuntimeRegistry } from "./core/registry.js";
import type { RuntimeStatus } from "./core/runtime.js";
import type { RuntimeModel } from "./definition/model.js";
import type { VersionPolicy } from "./definition/version.js";
import { compareSemver, parseSemver } from "./discovery/version.js";
import type { SemVer } from "./discovery/version.js";

/** `2.1.276 (Claude Code)` → `2.1.276`; unparseable strings pass through. */
function shortVersion(raw: string): string {
  const parsed = parseSemver(raw);
  return parsed ? `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}` : raw;
}
import { agentSearchDirs } from "./discovery/executable.js";
import type { InstalledCopy, InstallManager } from "./discovery/installs.js";
import { fetchLatestVersion, updateAvailable } from "./discovery/updates.js";
import { ADVISORY_PROBE_FLAGS } from "./discovery/capabilities.js";

export type DoctorStatus = "ok" | "warn" | "fail";

/**
 * Machine-readable cause for a non-ok check (mirrors open-design
 * `diagnostics.ts` reason codes). Lets callers branch without string-matching
 * prose, and tells humans where to fix. Only codes the probes can actually
 * distinguish are emitted — `configured-bin-invalid` / `not-executable`
 * arrive with the executable-hardening work (X_OK checks, override-cause
 * plumbing), not here.
 */
export type DoctorReason =
  | "not-on-path"
  | "shim-broken"
  | "version-probe-failed"
  | "untested-version"
  | "auth-missing"
  | "auth-unknown"
  | "model-list-unknown"
  | "model-probe-failed"
  | "mcp-empty"
  | "mcp-unknown"
  | "skills-empty"
  | "skills-unknown"
  | "plugins-empty"
  | "plugins-unknown"
  | "update-available"
  | "unsupported";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** Present on every non-ok check; absent on ok rows (healthy needs no cause). */
  reason?: DoctorReason;
  /**
   * Where detection looked, on `not-on-path` rows only. Capped
   * (MAX_SEARCHED_DIRS) — the full list is a UI concern, not a CLI line.
   */
  searchedDirs?: string[];
}

/** Cap on attached search dirs (mirrors daemon diagnostics). */
const MAX_SEARCHED_DIRS = 24;

/** Cap on install copies per row — real machines carry a handful at most. */
const MAX_INSTALL_ROWS = 8;

/**
 * One-line install inventory: `npm 1.18.31 (selected), bun 1.17.9`.
 * Versions are shortened to semver when parseable (the full probe string
 * already lives on the Version row); unprobable reads `unknown`, dead
 * copies get `(unusable)`.
 */
export function formatInstalls(copies: InstalledCopy[]): string {
  const shown = copies.slice(0, MAX_INSTALL_ROWS).map((c) => {
    const ver = c.version ? shortVersion(c.version) : "unknown";
    const bits = `${c.manager} ${ver}`;
    const flags = [c.selected ? "selected" : "", c.invocable ? "" : "unusable"]
      .filter((f) => f.length > 0)
      .join(", ");
    return flags.length > 0 ? `${bits} (${flags})` : bits;
  });
  return copies.length > MAX_INSTALL_ROWS ? `${shown.join(", ")}, …` : shown.join(", ");
}

export interface DoctorReport {
  id: string;
  name: string;
  checks: DoctorCheck[];
  /**
   * Update facts behind an `update-available` Version row (at most one: the
   * selected copy — what detect() picked = what runs). Absent when current
   * or unchecked, so old JSON keeps its shape. The CLI renders these as
   * stderr nudge lines; `--json` consumers get the structured facts here
   * instead of parsing prose.
   */
  updates?: DoctorUpdate[];
}

/** One known-newer release: plain strings, JSON-safe by construction. */
export interface DoctorUpdate {
  /** Selected copy's probed version, shortened like the Version row. */
  installed: string;
  /** Registry latest, shortened the same way. */
  latest: string;
  /** Who installed it — decides whether the CLI can print a command. */
  manager: InstallManager;
  /** npm package the check ran against (the upgrade target). */
  package: string;
}

/**
 * One-line model summary for the doctor Model row. Provider-first: the raw
 * list is huge (opencode reports 100+) and truncating to the first few ids
 * hides custom providers declared in config files (e.g. a `bai/...` model
 * behind the head of an `opencode/*` list). Distinct providers are bounded
 * and answer "is my provider recognized?" at a glance.
 */
export function summarizeModels(models: RuntimeModel[]): string {
  const count = String(models.length);
  const providers = [
    ...new Set(
      models.map((m) => {
        if (m.provider) return m.provider;
        // Same `provider/model` split as model discovery (models.ts).
        const slash = m.id.indexOf("/");
        return slash > 0 ? m.id.slice(0, slash) : "";
      }),
    ),
  ]
    .filter((p) => p.length > 0)
    .sort();
  if (providers.length === 0) return `${count} model(s)`;
  const shown = providers.slice(0, 8).join(", ");
  const noun = providers.length === 1 ? "provider" : "providers";
  return `${count} model(s) across ${String(providers.length)} ${noun}: ${shown}${
    providers.length > 8 ? ", …" : ""
  }`;
}
async function safe<T>(fn: () => Promise<T>): Promise<{ value: T | null; message: string | null }> {
  try {
    return { value: await fn(), message: null };
  } catch (err) {
    return { value: null, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Phase 19 (light) — probe a registered runtime and report its health.
 * Reuses the existing detect/capabilities/models probes; every probe is
 * isolated so one failure can't abort the report. Unknown ids reject with
 * RuntimeNotFoundError (same as runtimes.resolve).
 * `registry` is an injection seam for unit tests (stub runtimes without a CLI).
 */
export async function doctor(
  runtimeId: string,
  registry: Pick<RuntimeRegistry, "resolve"> = runtimes,
): Promise<DoctorReport> {
  const runtime = await registry.resolve(runtimeId);
  const info = runtime.info();
  const checks: DoctorCheck[] = [];
  // Structured update facts for the report (set alongside the Version row).
  let update: DoctorUpdate | null = null;

  const detected = await safe(() => runtime.detect());
  const status: RuntimeStatus | null = detected.value;
  // Install inventory doubles as the update-check input (single enumeration).
  const installed = await safe(() => runtime.installs());
  const copies = installed.value ?? [];
  if (status?.installed) {
    checks.push({ name: "Executable", status: "ok", detail: status.executable });
    if (status.version) {
      const assessment = assessCliVersion(info.versionPolicy, status.version);
      // A newer release appends to the row itself: `0.150.1 → 0.155.1`.
      // Compared against the SELECTED copy (what detect() picked = what runs).
      // Fail-open: offline/unknown registry yields no suffix, so a plain
      // version means "current or unchecked" — never an error row.
      const pending = await pendingUpdate(info.registryId, copies);
      const suffix = pending.suffix;
      update = pending.update;
      if (!assessment.ok) {
        checks.push({
          name: "Version",
          status: "warn",
          detail: `${status.version}${suffix} — ${assessment.detail}`,
          reason: "untested-version",
        });
      } else if (assessment.ahead) {
        // Newer than every tested build: still ok (fail-open), but say so —
        // staleness is visible without nagging, and nobody has to wonder
        // whether the `tested` table needs a hand edit (it doesn't).
        checks.push({
          name: "Version",
          status: suffix ? "warn" : "ok",
          detail: `${status.version}${suffix} (newer than tested ${assessment.ahead} — fail-open)`,
          ...(suffix ? { reason: "update-available" as const } : {}),
        });
      } else if (suffix) {
        checks.push({
          name: "Version",
          status: "warn",
          detail: `${status.version}${suffix}`,
          reason: "update-available",
        });
      } else {
        checks.push({ name: "Version", status: "ok", detail: status.version });
      }
    } else if (isWindowsShim(status.executable)) {
      // A `.cmd`/`.bat` that exists but can't be version-probed is the
      // shim-broken shape (CreateProcess cannot execute batch files, and a
      // shim whose node target vanished fails the same way). Keyed off the
      // file suffix, never the runtime id.
      checks.push({
        name: "Version",
        status: "warn",
        detail: "installed, version unknown",
        reason: "shim-broken",
      });
    } else {
      checks.push({
        name: "Version",
        status: "warn",
        detail: "installed, version unknown",
        reason: "version-probe-failed",
      });
    }
  } else {
    checks.push({
      name: "Executable",
      status: "fail",
      detail: detected.message ?? "not found on PATH",
      reason: "not-on-path",
      searchedDirs: agentSearchDirs().slice(0, MAX_SEARCHED_DIRS),
    });
    checks.push({
      name: "Version",
      status: "fail",
      detail: "runtime not installed",
      reason: "not-on-path",
    });
  }

  if (installed.value && installed.value.length > 0) {
    const anyUsable = installed.value.some((c) => c.invocable);
    checks.push(
      anyUsable
        ? { name: "Installs", status: "ok", detail: formatInstalls(installed.value) }
        : {
            name: "Installs",
            status: "warn",
            detail: `${formatInstalls(installed.value)} — none invocable`,
            reason: "shim-broken",
          },
    );
  }

  // Advisory help-flag inventory (never a warning): shows which channels
  // the installed CLI actually advertises, so capability staleness is
  // visible without anyone hand-editing version tables. Skipped when the
  // runtime is missing or the probe yields nothing.
  if (status?.installed) {
    const probed = await safe<Record<string, boolean>>(
      async () => (await runtime.probeFlags?.(ADVISORY_PROBE_FLAGS, status.executable)) ?? {},
    );
    const hits = ADVISORY_PROBE_FLAGS.filter((f) => probed.value?.[f] === true);
    if (hits.length > 0) {
      checks.push({
        name: "Flags",
        status: "ok",
        detail: `${String(hits.length)}/${String(ADVISORY_PROBE_FLAGS.length)} advertised: ${hits.join(", ")}`,
      });
    }
  }

  const authed = await safe(() => runtime.auth());
  if (authed.value?.authenticated) {
    checks.push({ name: "Authentication", status: "ok", detail: authed.value.detail });
  } else if (authed.value && authed.value.method === "none") {
    // The probe ran and the CLI positively reports logged-out/empty.
    checks.push({
      name: "Authentication",
      status: "warn",
      detail: authed.value.detail,
      reason: "auth-missing",
    });
  } else {
    // Never "fail": auth is not run-blocking per doctorExitCode, and an
    // "unknown" probe must not read as logged-out — detail says which.
    checks.push({
      name: "Authentication",
      status: "warn",
      detail: authed.value?.detail ?? authed.message ?? "auth status unknown",
      reason: "auth-unknown",
    });
  }

  const caps = runtime.capabilities();
  const capabilityRows: Array<[string, boolean]> = [
    ["Streaming", caps.streaming],
    ["Session Resume", caps.sessionResume],
    ["Model Selection", caps.modelSelection],
    ["Reasoning", caps.reasoning],
    ["Image Input", caps.images],
    ["Workspace", caps.workspace],
  ];
  for (const [name, supported] of capabilityRows) {
    checks.push(
      supported
        ? { name, status: "ok", detail: "supported" }
        : { name, status: "fail", detail: "not supported", reason: "unsupported" },
    );
  }

  const modeled = await safe(() => runtime.models());
  if (modeled.value && modeled.value.length > 0) {
    checks.push({ name: "Model", status: "ok", detail: summarizeModels(modeled.value) });
  } else if (modeled.value) {
    // Empty list means "unknown", not "none" — the runtime can still run on
    // its default model, so warn instead of fail (never show a stale static
    // list as if it were live data).
    checks.push({
      name: "Model",
      status: "warn",
      detail: "model list unknown",
      reason: "model-list-unknown",
    });
  } else {
    checks.push({
      name: "Model",
      status: "fail",
      detail: modeled.message ?? "no models discovered",
      reason: "model-probe-failed",
    });
  }

  const mcped = await safe(() => runtime.mcp());
  if (mcped.value && mcped.value.length > 0) {
    const names = mcped.value.map((s) => s.name).join(", ");
    checks.push({
      name: "MCP",
      status: "ok",
      detail: `${String(mcped.value.length)} server(s): ${names}`,
    });
  } else if (mcped.value && mcped.value.length === 0) {
    checks.push({ name: "MCP", status: "warn", detail: "no MCP servers", reason: "mcp-empty" });
  } else {
    checks.push({
      name: "MCP",
      status: "warn",
      detail: mcped.message ?? "MCP status unknown",
      reason: "mcp-unknown",
    });
  }

  const skilled = await safe(() => runtime.skills());
  if (skilled.value && skilled.value.length > 0) {
    const names = skilled.value.map((s) => s.id).join(", ");
    checks.push({
      name: "Skills",
      status: "ok",
      detail: `${String(skilled.value.length)} skill(s): ${names}`,
    });
  } else if (skilled.value && skilled.value.length === 0) {
    checks.push({
      name: "Skills",
      status: "warn",
      detail: "no skills found",
      reason: "skills-empty",
    });
  } else {
    checks.push({
      name: "Skills",
      status: "warn",
      detail: skilled.message ?? "Skills status unknown",
      reason: "skills-unknown",
    });
  }

  const plugged = await safe(() => runtime.plugins());
  if (plugged.value && plugged.value.length > 0) {
    const names = plugged.value.map((s) => s.id).join(", ");
    checks.push({
      name: "Plugins",
      status: "ok",
      detail: `${String(plugged.value.length)} plugin(s): ${names}`,
    });
  } else if (plugged.value && plugged.value.length === 0) {
    checks.push({
      name: "Plugins",
      status: "warn",
      detail: "no plugins configured",
      reason: "plugins-empty",
    });
  } else {
    checks.push({
      name: "Plugins",
      status: "warn",
      detail: plugged.message ?? "Plugins status unknown",
      reason: "plugins-unknown",
    });
  }

  return {
    id: runtime.id,
    name: info.name,
    checks,
    // Structured update facts ride along only when there is something to
    // say — same data the suffix used, no second fetch.
    ...(update ? { updates: [update] } : {}),
  };
}

/** Batch/shim wrapper suffixes that `spawn(shell:false)` cannot execute. */
function isWindowsShim(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable.trim());
}

/**
 * ` → <latest>` suffix for the Version row when the selected copy lags the
 * registry, plus the structured facts behind it (for the CLI nudge line and
 * `--json` consumers). One registry hit total — the facts reuse the exact
 * fetch the suffix needs. "" / null when current, unchecked (no
 * registryId), or unreachable — callers cannot tell "current" from
 * "unchecked", hence the wording rule: a plain version never implies a
 * completed check.
 */
async function pendingUpdate(
  registryId: string | undefined,
  copies: InstalledCopy[],
): Promise<{ suffix: string; update: DoctorUpdate | null }> {
  const none = { suffix: "", update: null };
  if (!registryId) return none;
  const selected = copies.find((c) => c.selected) ?? copies.find((c) => c.invocable);
  if (!selected?.version) return none;
  const latest = await fetchLatestVersion(registryId);
  if (!latest || !updateAvailable(selected.version, latest)) return none;
  const short = shortVersion(latest);
  return {
    suffix: ` → ${short}`,
    update: {
      installed: shortVersion(selected.version),
      latest: short,
      manager: selected.manager,
      package: registryId,
    },
  };
}

/**
 * Judge a probed CLI version against the adapter policy. Fail-open everywhere
 * judgment is impossible: no policy, unparseable version, or newer than all
 * tested → ok. Warns only on evidence: below the hard floor, or older than
 * every tested build (which may predate flags this library relies on).
 * A newer-than-tested install returns ok *with* the tested list attached, so
 * the Version row can say so — the `tested` table going stale is visible,
 * never a warning, and never a reason to hand-edit it on upgrade.
 */
function assessCliVersion(
  policy: VersionPolicy | undefined,
  version: string,
): { ok: true; ahead?: string } | { ok: false; detail: string } {
  if (!policy) return { ok: true };
  const current = parseSemver(version);
  if (policy.minimum) {
    const floor = parseSemver(policy.minimum);
    if (current && floor && compareSemver(current, floor) < 0) {
      return { ok: false, detail: `requires CLI >= ${policy.minimum}` };
    }
  }
  const tested = policy.tested ?? [];
  if (current && tested.length > 0) {
    const parsed = tested.map((t) => parseSemver(t)).filter((v): v is SemVer => v !== null);
    const max = parsed.reduce<SemVer | null>(
      (best, t) => (best === null || compareSemver(t, best) > 0 ? t : best),
      null,
    );
    if (max && compareSemver(current, max) < 0) {
      return { ok: false, detail: `older than tested (${tested.join(", ")})` };
    }
    if (max && compareSemver(current, max) > 0) {
      return { ok: true, ahead: tested.join(", ") };
    }
  }
  return { ok: true };
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

/**
 * Brand colors by runtime id (24-bit). Unknown ids stay plain — color is
 * decoration, never information a script must parse.
 */
const AGENT_COLORS: Partial<Record<string, [number, number, number]>> = {
  opencode: [128, 128, 128],
  "opencode-acp": [128, 128, 128],
  claude: [217, 119, 87],
  codex: [55, 96, 223],
};

function colorizeAgentName(id: string, name: string, color: boolean): string {
  if (!color) return name;
  const rgb = AGENT_COLORS[id];
  if (!rgb) return name;
  return `\x1b[38;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m${name}\x1b[0m`;
}

/** Whether ANSI colors may be emitted: explicit flag wins, otherwise TTY-only. */
function autoColor(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env["FORCE_COLOR"] !== undefined && process.env["FORCE_COLOR"] !== "0") return true;
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["TERM"] === "dumb") return false;
  return process.stdout.isTTY;
}

export function formatReport(report: DoctorReport, options?: { color?: boolean }): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const color = autoColor(options?.color);
  const lines = [
    "Agent Runtime Doctor",
    "",
    colorizeAgentName(report.id, report.name, color),
    "────────────────────────────",
    "",
  ];
  for (const c of report.checks) {
    // Reason codes render inline so a glance tells you where to fix; absent on ok rows.
    const suffix = c.reason ? ` [${c.reason}]` : "";
    const searched =
      c.searchedDirs && c.searchedDirs.length > 0
        ? ` — looked in: ${formatSearchedDirs(c.searchedDirs)}`
        : "";
    lines.push(`${c.name.padEnd(width)}   ${GLYPH[c.status]}  ${c.detail}${suffix}${searched}`);
  }
  return lines.join("\n");
}

/** First 8 dirs verbatim, remainder as a count — CLI lines stay readable. */
function formatSearchedDirs(dirs: string[]): string {
  const shown = dirs.slice(0, 8).join("; ");
  return dirs.length > 8 ? `${shown}; (+${String(dirs.length - 8)} more)` : shown;
}

/**
 * Exit code for the CLI. Only run-blocking rows fail the command
 * (Executable/Version/Model) — capability rows like Image Input display
 * honestly but don't block usage, so they must not turn every run red.
 */
const BLOCKING_ROWS = new Set(["Executable", "Version", "Model"]);

export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some((c) => c.status === "fail" && BLOCKING_ROWS.has(c.name)) ? 1 : 0;
}
