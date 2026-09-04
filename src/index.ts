export const version = "0.1.0";

// Definition
export type { RuntimeDefinition } from "./definition/index.js";
export type { RuntimeIdentity } from "./definition/identity.js";
export type { ExecutableDefinition } from "./definition/executable.js";
export type { PromptInput } from "./definition/input.js";
export type { TransportDefinition } from "./definition/transport.js";
export type { RuntimeCapabilities } from "./definition/capability.js";
export type { SessionDefinition } from "./definition/session.js";
export type { RuntimeModel, ModelDefinition } from "./definition/model.js";
export type { ReasoningEffort, ReasoningOptions } from "./definition/reasoning.js";
export type { McpServer } from "./definition/mcp.js";
export type { AuthMethod, AuthStatus } from "./definition/auth.js";
export type { WorkspaceOptions } from "./definition/workspace.js";
export type { PermissionHandler, PermissionRequest, PermissionResponse } from "./definition/permission.js";
export type { ImageInput } from "./definition/image.js";
export { saveSessionRecord, loadSessionRecord, listSessionRecords, deleteSessionRecord, getSessionStoreDir, setSessionStoreDir } from "./core/session-store.js";
export type { SessionRecord } from "./core/session-store.js";

// Core
export type {
  AgentRuntime,
  AgentSession,
  CreateSessionOptions,
  RuntimeInfo,
  RuntimeStatus,
} from "./core/runtime.js";
export { DefaultRuntime } from "./core/runtime.js";
export { RuntimeRegistry, globalRegistry } from "./core/registry.js";
export { runtimes } from "./runtimes.js";
export { doctor, formatReport, doctorExitCode } from "./doctor.js";
export type { DoctorCheck, DoctorReport, DoctorStatus } from "./doctor.js";
export {
  RuntimeError,
  RuntimeNotFoundError,
  RuntimeProtocolError,
  RuntimeSessionError,
  RuntimeSpawnError,
  RuntimeTimeoutError,
  RuntimeVersionError,
} from "./core/errors.js";
export type { ProcessExit, ProcessState, SpawnOptions } from "./core/lifecycle.js";
export { RuntimeProcess } from "./core/lifecycle.js";
export type { AgentRun, RunOptions } from "./core/run.js";
export { DefaultRun } from "./core/run.js";
export { DefaultSession } from "./core/session.js";

// Events
export type {
  DoneEvent,
  ErrorEvent,
  RuntimeEvent,
  SessionStartedEvent,
  TextDeltaEvent,
  ToolFinishedEvent,
  ToolStartedEvent,
} from "./events/index.js";
export { EventStream } from "./events/index.js";

// Transport / Parser
export type { RuntimeTransport } from "./transport/transport.js";
export { StdioTransport } from "./transport/stdio.js";
export { AcpTransport } from "./transport/acp.js";
export type { AcpMessage, AcpRequestOptions, AcpMcpServer } from "./transport/acp.js";
export { buildAcpMcpServers } from "./transport/acp.js";
export type { RuntimeParser } from "./parser/parser.js";
export { JsonlParser } from "./parser/jsonl.js";
export { AcpParser } from "./parser/acp.js";
export { AcpRun } from "./core/acp-run.js";
export type { AcpRunOptions } from "./core/acp-run.js";

// Discovery
export { findExecutable } from "./discovery/executable.js";
export { probeVersion } from "./discovery/version.js";
export { probeHelpFlags, capabilitiesFromHelp } from "./discovery/capabilities.js";
export { discoverModels } from "./discovery/models.js";
export { runCommand } from "./discovery/run-command.js";
export type { RunCommandOptions, RunCommandResult } from "./discovery/run-command.js";
export { resolveShimTarget } from "./discovery/npm-shim.js";
export type { ShimLaunch } from "./discovery/npm-shim.js";

// Runtimes
export {
  opencodeDefinition,
  buildOpencodeArgs,
  buildOpencodeMcpConfig,
  type OpencodeBuildArgsOptions,
} from "../runtimes/opencode/definition.js";
export { OpencodeParser } from "../runtimes/opencode/parser.js";
export { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
export {
  claudeDefinition,
  buildClaudeArgs,
  buildClaudeMcpConfig,
  buildClaudeMcpAllowedTools,
  type ClaudeBuildArgsOptions,
} from "../runtimes/claude/definition.js";
export { ClaudeParser } from "../runtimes/claude/parser.js";
export { ClaudeRuntime } from "../runtimes/claude/runtime.js";
export {
  codexDefinition,
  buildCodexArgs,
  type CodexBuildArgsOptions,
} from "../runtimes/codex/definition.js";
export { CodexParser } from "../runtimes/codex/parser.js";
export { CodexRuntime } from "../runtimes/codex/runtime.js";
export {
  opencodeAcpDefinition,
  buildOpencodeAcpArgs,
} from "../runtimes/opencode-acp/definition.js";
export { OpencodeAcpRuntime } from "../runtimes/opencode-acp/runtime.js";
