export const version = "0.1.0";

// Definition
export type { RuntimeDefinition } from "./definition/index.js";
export type { RuntimeIdentity } from "./definition/identity.js";
export type { ExecutableDefinition } from "./definition/executable.js";
export type { PromptInput } from "./definition/input.js";
export type { TransportDefinition } from "./definition/transport.js";
export type { RuntimeCapabilities } from "./definition/capability.js";
export type { SessionDefinition } from "./definition/session.js";
export type { RuntimeModel, ModelDefinition, ModelReasoningOption } from "./definition/model.js";
export type { VersionPolicy } from "./definition/version.js";
export { sanitizeModelId } from "./definition/model.js";
export type { ReasoningEffort, ReasoningOptions } from "./definition/reasoning.js";
export type { McpServer, McpServerInfo } from "./definition/mcp.js";
export type { RuntimeSkill } from "./definition/skill.js";
export type { RuntimePlugin } from "./definition/plugin.js";
export type { AuthMethod, AuthStatus } from "./definition/auth.js";
export { stderrTail, withStderrTail } from "./definition/auth.js";
export type { WorkspaceOptions } from "./definition/workspace.js";
export type {
  PermissionHandler,
  PermissionRequest,
  PermissionResponse,
} from "./definition/permission.js";
export type { ImageInput } from "./definition/image.js";
export {
  truncateTranscriptText,
  selectHistory,
  toMs,
  MAX_TRANSCRIPT_TEXT,
} from "./definition/transcript.js";
export type { HistoryOptions, TranscriptEntry } from "./definition/transcript.js";
export {
  saveSessionRecord,
  loadSessionRecord,
  listSessionRecords,
  deleteSessionRecord,
  getSessionStoreDir,
  setSessionStoreDir,
} from "./core/session-store.js";
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
export { doctor, formatReport, doctorExitCode, formatInstalls, summarizeModels } from "./doctor.js";
export type { DoctorCheck, DoctorReport, DoctorStatus, DoctorReason } from "./doctor.js";
export {
  checkForUpdates,
  clearLatestCache,
  fetchLatestVersion,
  updateAvailable,
} from "./discovery/updates.js";
export type { UpdateInfo } from "./discovery/updates.js";
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
  JsonValue,
  PermissionRequestEvent,
  ReasoningDeltaEvent,
  RunScoped,
  RuntimeEvent,
  SessionStartedEvent,
  TextDeltaEvent,
  ToolFinishedEvent,
  ToolStartedEvent,
  UsageEvent,
} from "./events/index.js";
export { asJsonValue, EventStream } from "./events/index.js";

// Frontend wire contract (JSON-only boundary: DTOs + NDJSON framing)
export type { WireCreateSessionOptions } from "./wire.js";
export { decodeRuntimeEventLine, encodeRuntimeEvent, isRuntimeEvent } from "./wire.js";

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
export { findExecutable, agentSearchDirs } from "./discovery/executable.js";
export {
  isExecutableFile,
  rememberUnusableExecutable,
  forgetUnusableExecutables,
  resolveExtraProbePaths,
} from "./discovery/executable.js";
export { userToolchainBinDirs, toolchainProbePaths } from "./discovery/toolchain.js";
export { resolveLaunch } from "./discovery/launch.js";
export type { ResolvedLaunch } from "./discovery/launch.js";
export { probeVersion } from "./discovery/version.js";
export { probeHelpFlags, capabilitiesFromHelp } from "./discovery/capabilities.js";
export { discoverModels } from "./discovery/models.js";
export {
  assertKnownModel,
  clearLiveModels,
  isKnownModel,
  rememberLiveModels,
} from "./discovery/models.js";
export { discoverMcp, parseMcpList } from "./discovery/mcp.js";
export { discoverSkills, parseSkillFrontmatter, skillSearchDirs } from "./discovery/skills.js";
export type { SkillRoot, SkillSearchOptions } from "./discovery/skills.js";
export {
  discoverPlugins,
  parsePluginEntries,
  pluginConfigFiles,
  pluginSearchDirs,
  readPluginConfigFile,
  stripJsoncComments,
} from "./discovery/plugins.js";
export type { PluginConfigFile, PluginDir, PluginSearchOptions } from "./discovery/plugins.js";
export { runCommand } from "./discovery/run-command.js";
export type { RunCommandOptions, RunCommandResult } from "./discovery/run-command.js";
export { findAllInstalls, inferInstallManager } from "./discovery/installs.js";
export type { InstallManager, InstallSearchOptions, InstalledCopy } from "./discovery/installs.js";
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
export { OpencodeRuntime, readOpencodeAuthFile } from "../runtimes/opencode/runtime.js";
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
  checkCodexModelSupport,
  readCodexDefaultModel,
  resolveCodexConfigPath,
  type CodexBuildArgsOptions,
  type CodexDefaultModel,
  type CodexModelSupport,
} from "../runtimes/codex/definition.js";
export { CodexParser } from "../runtimes/codex/parser.js";
export { CodexRuntime } from "../runtimes/codex/runtime.js";
export {
  opencodeAcpDefinition,
  buildOpencodeAcpArgs,
} from "../runtimes/opencode-acp/definition.js";
export { OpencodeAcpRuntime } from "../runtimes/opencode-acp/runtime.js";
