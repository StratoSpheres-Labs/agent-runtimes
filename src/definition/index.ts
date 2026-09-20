/**
 * Single source-of-truth for what describes a runtime adapter.
 * Composes the per-concern definitions from Phase 1.
 */

export type { RuntimeIdentity } from "./identity.js";
export type { ExecutableDefinition } from "./executable.js";
export type { PromptInput } from "./input.js";
export type { TransportDefinition } from "./transport.js";
export type { RuntimeCapabilities } from "./capability.js";
export type { SessionDefinition } from "./session.js";
export type { RuntimeModel, ModelDefinition } from "./model.js";
export type { VersionPolicy } from "./version.js";
export type { ReasoningEffort, ReasoningOptions } from "./reasoning.js";
export type { McpServer, McpServerInfo } from "./mcp.js";
export type { RuntimeSkill } from "./skill.js";
export type { RuntimePlugin } from "./plugin.js";
export type { AuthMethod, AuthStatus } from "./auth.js";
export type { WorkspaceOptions } from "./workspace.js";
export type {
  PermissionHandler,
  PermissionRequest,
  PermissionResponse,
  PermissionOption,
} from "./permission.js";
export type { ImageInput } from "./image.js";

import type { RuntimeIdentity } from "./identity.js";
import type { ExecutableDefinition } from "./executable.js";
import type { PromptInput } from "./input.js";
import type { TransportDefinition } from "./transport.js";
import type { RuntimeCapabilities } from "./capability.js";
import type { SessionDefinition } from "./session.js";
import type { ModelDefinition } from "./model.js";
import type { VersionPolicy } from "./version.js";

/**
 * Complete runtime definition — what an adapter must provide.
 * Core stays agent-agnostic by depending only on this shape
 * (Rule 1: no `if (id === "xxx")` in src/core/**).
 */
export interface RuntimeDefinition {
  identity: RuntimeIdentity;
  executable: ExecutableDefinition;
  input: PromptInput;
  transport: TransportDefinition;
  capabilities: RuntimeCapabilities;
  session: SessionDefinition;
  models?: ModelDefinition;
  /** Tested/minimum CLI versions — drives the doctor `untested-version` warning. */
  versionPolicy?: VersionPolicy;
}
