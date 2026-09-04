import { resolve } from "node:path";
import { DefaultRuntime } from "../../src/core/runtime.js";
import type { AgentSession, CreateSessionOptions } from "../../src/core/runtime.js";
import type { AuthStatus } from "../../src/definition/auth.js";
import { opencodeAcpDefinition, buildOpencodeAcpArgs } from "./definition.js";
import { OpencodeAcpSession } from "./session.js";
import { probeOpencodeAuth } from "../opencode/runtime.js";

export class OpencodeAcpRuntime extends DefaultRuntime {
  public constructor() {
    super(opencodeAcpDefinition);
  }

  public buildArgs(): string[] {
    return buildOpencodeAcpArgs();
  }

  public override async createSession(options?: CreateSessionOptions): Promise<AgentSession> {
    const { cwd, model, mcpServers, workspace, onPermissionRequest, resumeSessionId } = options ?? {};
    const status = await this.detect();
    const command = status.installed ? status.executable : opencodeAcpDefinition.executable.command;
    // Absolute: the path goes to both the child cwd and session/new.
    const runCwd = cwd ? resolve(cwd) : process.cwd();
    const sid = `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new OpencodeAcpSession({ id: sid, command, cwd: runCwd, model, mcpServers, workspace, onPermissionRequest, resumeSessionId });
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
}
