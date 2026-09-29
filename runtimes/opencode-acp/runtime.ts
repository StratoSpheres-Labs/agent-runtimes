import { resolve } from "node:path";
import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import type { AuthStatus } from "../../src/definition/auth.js";
import { opencodeAcpDefinition, buildOpencodeAcpArgs } from "./definition.js";
import { assertKnownModel } from "../../src/discovery/models.js";
import { OpencodeAcpSession } from "./session.js";
import { probeOpencodeAuth } from "../opencode/runtime.js";
import { discoverMcp } from "../../src/discovery/mcp.js";
import type { McpServerInfo } from "../../src/definition/mcp.js";
import {
  assertSessionInputsSupported,
  assertWorkspaceFieldsSupported,
} from "../../src/definition/session-inputs.js";

export class OpencodeAcpRuntime extends DefaultRuntime {
  public constructor() {
    super(opencodeAcpDefinition);
  }

  public buildArgs(): string[] {
    return buildOpencodeAcpArgs();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const {
      cwd,
      model,
      reasoning,
      agent,
      systemPrompt,
      maxTokens,
      maxBudgetUsd,
      outputSchema,
      profile,
      allowedTools,
      seedMessages,
      mcpServers,
      workspace,
      onPermissionRequest,
      resumeSessionId,
      logger,
    } = options ?? {};
    // Reject inputs with no ACP channel before anything spawns: no
    // reasoning / agent / system-prompt / token-budget / cost-budget /
    // schema / profile / allowlist channels exist, and workspace has no
    // native flag.
    assertSessionInputsSupported("opencode-acp", opencodeAcpDefinition.capabilities, {
      agent,
      systemPrompt,
      maxTokens,
      maxBudgetUsd,
      outputSchema,
      profile,
      allowedTools,
      seedMessages,
      reasoning,
    });
    assertWorkspaceFieldsSupported("opencode-acp", [], workspace);
    await assertKnownModel(
      opencodeAcpDefinition.identity.id,
      model,
      opencodeAcpDefinition.models?.fallbackModels ?? [],
      () => this.models(),
    );
    const status = await this.detect();
    const command = status.installed ? status.executable : opencodeAcpDefinition.executable.command;
    // Absolute: the path goes to both the child cwd and session/new.
    const runCwd = cwd ? resolve(cwd) : process.cwd();
    const sid = `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new OpencodeAcpSession({
      id: sid,
      command,
      cwd: runCwd,
      model,
      mcpServers,
      workspace,
      onPermissionRequest,
      resumeSessionId,
      logger,
    });
  }

  public override async auth(): Promise<AuthStatus> {
    // Same underlying opencode credential store — reuse its probe.
    const status = await this.detect();
    if (!status.installed) {
      return {
        authenticated: false,
        method: "unknown",
        detail: "opencode is not installed — auth status unknown",
      };
    }
    return probeOpencodeAuth(status.executable);
  }

  public override async mcp(): Promise<McpServerInfo[]> {
    const status = await this.detect();
    if (!status.installed) return [];
    return discoverMcp(status.executable, ["mcp", "list"]);
  }
}
