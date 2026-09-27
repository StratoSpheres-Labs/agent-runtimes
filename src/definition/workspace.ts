/**
 * Agent-agnostic workspace constraints — Phase 23.
 * Unifies the per-CLI multi-root / sandbox / permission knobs that are
 * otherwise dead code in buildArgs (Rule 2: caller never sees --add-dir etc.).
 * Core stores this shape; each adapter translates it into its native flags.
 * OpenDesign daemon analogy: RuntimeAgentDef.permissions/workspace.
 */
export interface WorkspaceOptions {
  /** Extra allowed roots beyond `cwd` — Claude `--add-dir`, Codex `-C`. */
  allowedPaths?: string[];
  /** Claude `--permission-mode` (e.g. "default" | "plan" | "bypassPermissions"). */
  permissionMode?: string;
  /** Claude `--dangerously-skip-permissions` — open-design uses `bypassPermissions` instead; this is an explicit dangerous opt-in. */
  dangerouslySkipPermissions?: boolean;
  /** Codex sandbox — new `codex exec --sandbox <mode>` / resume `-c sandbox_mode="..."`. */
  sandboxMode?: string;
  /**
   * Route approval requests through automatic review (codex
   * `--approve-for-me`: reviewer agent + forced `workspace-write` +
   * `on-request` policy). Approval delegation, not a permission grant —
   * sandbox boundaries stay intact. Mutually exclusive with `sandboxMode`
   * and `dangerouslySkipPermissions` (the CLI rejects the combination);
   * create-only (`exec resume` has no such flag).
   */
  autoReview?: boolean;
}

import { isAbsolute, resolve } from "node:path";

/**
 * Whether the workspace bag carries anything an adapter would need to
 * act on. Adapters with no (or partial) native wiring use this to reject
 * unsupported fields loudly instead of silently ignoring them — see
 * `assertWorkspaceFieldsSupported` (src/definition/session-inputs.ts).
 */
export function hasWorkspaceFields(workspace: WorkspaceOptions | undefined): boolean {
  if (!workspace) return false;
  return (
    (workspace.allowedPaths?.length ?? 0) > 0 ||
    workspace.permissionMode !== undefined ||
    workspace.dangerouslySkipPermissions === true ||
    workspace.sandboxMode !== undefined ||
    workspace.autoReview === true
  );
}

/**
 * Normalize allowed paths — resolve against cwd (or process.cwd()), dedupe,
 * filter empties. Never throws; empty input returns empty array.
 */
export function normalizeWorkspaceAllowedPaths(
  allowedPaths: string[] | undefined,
  cwd: string | undefined,
): string[] {
  if (allowedPaths === undefined || allowedPaths.length === 0) return [];
  const baseCwd = cwd ?? process.cwd();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of allowedPaths) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const abs = isAbsolute(trimmed) ? trimmed : resolve(baseCwd, trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
