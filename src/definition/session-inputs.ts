import { RuntimeSessionError } from "../core/errors.js";
import type { RuntimeCapabilities } from "./capability.js";
import type { ReasoningOptions } from "./reasoning.js";
import type { WorkspaceOptions } from "./workspace.js";
import { hasWorkspaceFields } from "./workspace.js";

/**
 * Batch 1–3 input surface — one shape for "everything the caller can ask
 * a session to do". `CreateSessionOptions` (src/core/runtime.ts) mirrors
 * these fields; adapters declare support via `RuntimeCapabilities` and
 * reject the rest loudly here (never silently ignore — the codex-MCP
 * precedent). Workspace sub-fields stay per-adapter (each CLI wires a
 * different subset); everything else is capability-gated in one place.
 */

export interface SeedMessage {
  role: "user" | "assistant";
  text: string;
}

/** Structural input bag — adapters pass their (compatible) options object. */
export interface SessionInputRequest {
  agent?: string;
  systemPrompt?: string;
  maxTokens?: number;
  maxBudgetUsd?: number;
  outputSchema?: Record<string, unknown> | string;
  profile?: string;
  allowedTools?: string[];
  seedMessages?: SeedMessage[];
  reasoning?: ReasoningOptions;
}

/**
 * Byte cap on a JSON Schema payload. Claude carries the schema on argv
 * (Windows CreateProcess totals ~32k for the whole command line), so
 * schemas stay small by construction; codex staging inherits the same
 * bound for one shared contract.
 */
export const MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True for values JSON.stringify would silently drop or choke on. */
function containsNonJson(value: unknown): boolean {
  if (
    typeof value === "function" ||
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.some(containsNonJson);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsNonJson);
  }
  return false;
}

/**
 * Normalize a caller schema to its canonical JSON string. Accepts a plain
 * object or a JSON string; blank input means "absent" (never an error).
 * Throws on anything else — arrays, primitives, unparseable text, and
 * payloads that would silently change shape through JSON (functions,
 * undefined, symbols, bigint, circular refs) are rejected, never coerced.
 * Over-cap payloads throw (argv safety). Pure — adapters call it once at
 * session creation (fail fast), sessions carry the normalized string.
 */
export function normalizeOutputSchema(
  value: Record<string, unknown> | string | undefined,
  runtime: string,
): string | undefined {
  if (value === undefined) return undefined;
  let obj: unknown = value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return undefined;
    try {
      obj = JSON.parse(value) as unknown;
    } catch {
      throw new RuntimeSessionError("invalid outputSchema: not parseable JSON", {
        runtime,
      });
    }
  }
  if (!isPlainObject(obj)) {
    throw new RuntimeSessionError("invalid outputSchema: must be a JSON object", { runtime });
  }
  if (containsNonJson(obj)) {
    throw new RuntimeSessionError(
      "invalid outputSchema: must be plain JSON data (no functions/undefined/symbols/bigint)",
      { runtime },
    );
  }
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    throw new RuntimeSessionError("invalid outputSchema: not serializable JSON", { runtime });
  }
  if (Buffer.byteLength(json, "utf-8") > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new RuntimeSessionError(
      `invalid outputSchema: ${String(Buffer.byteLength(json, "utf-8"))} bytes exceeds the ${String(MAX_OUTPUT_SCHEMA_BYTES)} byte budget`,
      { runtime },
    );
  }
  return json;
}

/**
 * Reject session inputs the runtime cannot honor. Call FIRST in every
 * adapter's `createSession` (before `detect()` / model probes) so a
 * refused session never spawns and never mints a native id.
 * Empty/absent values are no-ops (never an error).
 */
export function assertSessionInputsSupported(
  runtime: string,
  caps: RuntimeCapabilities,
  opts: SessionInputRequest,
): void {
  if (opts.agent !== undefined && opts.agent.trim().length > 0 && !caps.agentSelection) {
    throw new RuntimeSessionError(
      `${runtime} sessions do not support agent selection: agent "${opts.agent}" was provided but this runtime has no agent flag`,
      { runtime },
    );
  }
  if (opts.profile !== undefined && opts.profile.trim().length > 0 && !caps.profileSelection) {
    throw new RuntimeSessionError(
      `${runtime} sessions do not support config profiles: profile "${opts.profile}" was provided but this runtime has no profile flag`,
      { runtime },
    );
  }
  if (opts.systemPrompt !== undefined && opts.systemPrompt.trim().length > 0) {
    if (!caps.systemPrompt) {
      throw new RuntimeSessionError(
        `${runtime} sessions do not support caller system prompts: systemPrompt was provided but this runtime has no system-prompt channel`,
        { runtime },
      );
    }
  }
  if (opts.maxTokens !== undefined) {
    const budget = opts.maxTokens;
    if (!Number.isInteger(budget) || budget < 1) {
      throw new RuntimeSessionError(
        `invalid maxTokens ${JSON.stringify(opts.maxTokens)} for ${runtime} — must be a positive integer`,
        { runtime },
      );
    }
    if (!caps.maxTokens) {
      throw new RuntimeSessionError(
        `${runtime} sessions do not support token budgets: maxTokens was provided but this runtime has no max-tokens channel`,
        { runtime },
      );
    }
  }
  if (opts.maxBudgetUsd !== undefined) {
    // Read through unknown on purpose: a JS caller can hand a non-number
    // past the types, and that lie must throw here (same as seed roles).
    const spend: unknown = opts.maxBudgetUsd;
    if (typeof spend !== "number" || !Number.isFinite(spend) || spend <= 0) {
      throw new RuntimeSessionError(
        `invalid maxBudgetUsd ${JSON.stringify(opts.maxBudgetUsd)} for ${runtime} — must be a positive dollar amount`,
        { runtime },
      );
    }
    if (!caps.costBudget) {
      throw new RuntimeSessionError(
        `${runtime} sessions do not support cost budgets: maxBudgetUsd was provided but this runtime has no cost-budget channel`,
        { runtime },
      );
    }
  }
  if (opts.outputSchema !== undefined) {
    const normalized = normalizeOutputSchema(opts.outputSchema, runtime);
    if (normalized !== undefined && !caps.structuredOutput) {
      throw new RuntimeSessionError(
        `${runtime} sessions do not support structured output: outputSchema was provided but this runtime has no schema channel`,
        { runtime },
      );
    }
  }
  if (opts.allowedTools !== undefined && opts.allowedTools.length > 0 && !caps.toolAllowlist) {
    throw new RuntimeSessionError(
      `${runtime} sessions do not support caller tool allowlists: allowedTools was provided but this runtime has no allowlist flag`,
      { runtime },
    );
  }
  if (opts.seedMessages !== undefined && opts.seedMessages.length > 0) {
    assertValidSeedMessages(runtime, opts.seedMessages);
    if (!caps.historySeed) {
      throw new RuntimeSessionError(
        `${runtime} sessions do not support history seeding: seedMessages was provided but no native transcript-injection channel exists — resume a native session id instead`,
        { runtime },
      );
    }
  }
  if (opts.reasoning !== undefined && !caps.reasoning) {
    throw new RuntimeSessionError(
      `${runtime} sessions do not support reasoning controls: reasoning was provided but this runtime has no reasoning channel`,
      { runtime },
    );
  }
}

/**
 * Shape-check seed messages (malformed input throws regardless of
 * support). Reads through `unknown` on purpose: a runtime-typed signature
 * cannot express "the caller lied about the role", and that lie must
 * throw here instead of passing the type-narrowed check.
 */
function assertValidSeedMessages(runtime: string, messages: SeedMessage[]): void {
  for (const m of messages) {
    const rec = m as unknown as Record<string, unknown>;
    const role = rec["role"];
    const text = rec["text"];
    const okRole = role === "user" || role === "assistant";
    const okText = typeof text === "string" && text.length > 0;
    if (!okRole || !okText) {
      throw new RuntimeSessionError(
        `invalid seedMessages entry for ${runtime} — each needs { role: "user" | "assistant", text: <non-empty> }`,
        { runtime },
      );
    }
  }
}

/**
 * Workspace presence check for per-adapter gating. Adapters whose CLI
 * wires only a subset (claude: no sandbox, codex: no permissionMode,
 * opencode/acp: nothing) reject the fields they cannot honor; the shared
 * assert above stays out of workspace (sub-field matrix differs per CLI).
 */
export function assertWorkspaceFieldsSupported(
  runtime: string,
  supported: ReadonlyArray<
    "allowedPaths" | "permissionMode" | "dangerouslySkipPermissions" | "sandboxMode" | "autoReview"
  >,
  workspace: WorkspaceOptions | undefined,
): void {
  if (!hasWorkspaceFields(workspace)) return;
  const w = workspace as WorkspaceOptions;
  const unsupported: string[] = [];
  if ((w.allowedPaths?.length ?? 0) > 0 && !supported.includes("allowedPaths")) {
    unsupported.push("allowedPaths");
  }
  if (w.permissionMode !== undefined && !supported.includes("permissionMode")) {
    unsupported.push("permissionMode");
  }
  if (w.dangerouslySkipPermissions === true && !supported.includes("dangerouslySkipPermissions")) {
    unsupported.push("dangerouslySkipPermissions");
  }
  if (w.sandboxMode !== undefined && !supported.includes("sandboxMode")) {
    unsupported.push("sandboxMode");
  }
  if (w.autoReview === true && !supported.includes("autoReview")) {
    unsupported.push("autoReview");
  }
  if (unsupported.length > 0) {
    throw new RuntimeSessionError(
      `${runtime} sessions do not support workspace ${unsupported.join(", ")}: this runtime only wires ${supported.length > 0 ? supported.join(", ") : "nothing"} — the rest would be silently ignored`,
      { runtime },
    );
  }
}

/**
 * Generic CLI config-id sanitizer (agent names, profile names). Ids ride
 * argv (`--agent <id>`, `-p <name>`), so a hostile value like
 * `--dangerously-skip-permissions` would parse as a flag. Same charset
 * discipline as `sanitizeModelId`, tighter length (single path segment).
 */
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function sanitizeConfigId(
  value: string | undefined,
  field: "agent" | "profile" | "mcpServer",
  runtime: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!CONFIG_ID_PATTERN.test(trimmed)) {
    throw new RuntimeSessionError(`invalid ${field} id: ${JSON.stringify(value)}`, {
      runtime,
    });
  }
  return trimmed;
}

/**
 * Resume/session-id sanitizer. Native ids ride argv (`--session`,
 * `--resume`, `--session-id`, codex's positional thread id), so a hostile
 * value like `--dangerously-skip-permissions` would parse as a flag.
 * Charset fits every id shape the CLIs mint (uuids, `ses_*`, thread ids);
 * anything else rejects loudly at session creation, never at turn time.
 */
const RESUME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sanitizeResumeId(value: string | undefined, runtime: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!RESUME_ID_PATTERN.test(trimmed)) {
    throw new RuntimeSessionError(`invalid resumeSessionId: ${JSON.stringify(value)}`, {
      runtime,
    });
  }
  return trimmed;
}

/**
 * Tool-name sanitizer for caller allowlists (`--allowedTools`). Covers
 * `Read`, `Bash`, `mcp__<server>__<tool>` and trailing-`*` scopes
 * (`mcp__github__*`). Malformed entries throw (never silently dropped —
 * a dropped entry would widen access beyond what the caller asked).
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.*-]{0,199}$/;

export function sanitizeToolName(value: string, runtime: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !TOOL_NAME_PATTERN.test(trimmed)) {
    throw new RuntimeSessionError(`invalid allowedTools entry: ${JSON.stringify(value)}`, {
      runtime,
    });
  }
  return trimmed;
}
