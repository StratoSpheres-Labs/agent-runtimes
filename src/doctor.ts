import { runtimes } from "./runtimes.js";
import type { RuntimeStatus } from "./core/runtime.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  id: string;
  name: string;
  checks: DoctorCheck[];
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
 */
export async function doctor(runtimeId: string): Promise<DoctorReport> {
  const runtime = await runtimes.resolve(runtimeId);
  const info = runtime.info();
  const checks: DoctorCheck[] = [];

  const detected = await safe(() => runtime.detect());
  const status: RuntimeStatus | null = detected.value;
  if (status?.installed) {
    checks.push({ name: "Executable", status: "ok", detail: status.executable });
    checks.push(
      status.version
        ? { name: "Version", status: "ok", detail: status.version }
        : { name: "Version", status: "warn", detail: "installed, version unknown" },
    );
  } else {
    checks.push({
      name: "Executable",
      status: "fail",
      detail: detected.message ?? "not found on PATH",
    });
    checks.push({ name: "Version", status: "fail", detail: "runtime not installed" });
  }

  const authed = await safe(() => runtime.auth());
  if (authed.value?.authenticated) {
    checks.push({ name: "Authentication", status: "ok", detail: authed.value.detail });
  } else {
    // Never "fail": auth is not run-blocking per doctorExitCode, and an
    // "unknown" probe must not read as logged-out — detail says which.
    checks.push({
      name: "Authentication",
      status: "warn",
      detail: authed.value?.detail ?? authed.message ?? "auth status unknown",
    });
  }

  const caps = runtime.capabilities();
  checks.push({
    name: "Streaming",
    status: caps.streaming ? "ok" : "fail",
    detail: caps.streaming ? "supported" : "not supported",
  });
  checks.push({
    name: "Session Resume",
    status: caps.sessionResume ? "ok" : "fail",
    detail: caps.sessionResume ? "supported" : "not supported",
  });
  checks.push({
    name: "Model Selection",
    status: caps.modelSelection ? "ok" : "fail",
    detail: caps.modelSelection ? "supported" : "not supported",
  });
  checks.push({
    name: "Reasoning",
    status: caps.reasoning ? "ok" : "fail",
    detail: caps.reasoning ? "supported" : "not supported",
  });
  checks.push({
    name: "Image Input",
    status: caps.images ? "ok" : "fail",
    detail: caps.images ? "supported" : "not supported",
  });
  checks.push({
    name: "Workspace",
    status: caps.workspace ? "ok" : "fail",
    detail: caps.workspace ? "supported" : "not supported",
  });

  const modeled = await safe(() => runtime.models());
  if (modeled.value && modeled.value.length > 0) {
    const count = String(modeled.value.length);
    const shown = modeled.value
      .slice(0, 5)
      .map((m) => m.id)
      .join(", ");
    checks.push({
      name: "Model",
      status: "ok",
      detail: `${count} model(s): ${shown}${modeled.value.length > 5 ? ", …" : ""}`,
    });
  } else {
    checks.push({
      name: "Model",
      status: "fail",
      detail: modeled.message ?? "no models discovered",
    });
  }

  checks.push({ name: "MCP", status: "warn", detail: "deferred to v0.2" });

  return { id: runtime.id, name: info.name, checks };
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export function formatReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = ["Agent Runtime Doctor", "", report.name, "────────────────────────────", ""];
  for (const c of report.checks) {
    lines.push(`${c.name.padEnd(width)}   ${GLYPH[c.status]}  ${c.detail}`);
  }
  return lines.join("\n");
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
