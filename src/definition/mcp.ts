/**
 * Agent-agnostic MCP server descriptor — Phase 21.
 * Callers declare stdio MCP servers per session via
 * `CreateSessionOptions.mcpServers`; each adapter translates this shape
 * into its native wiring (Rule 6 — no MCP wire format leaks):
 * - claude: `--mcp-config <tmpfile>` with `{"mcpServers": {...}}`
 * - opencode CLI: `OPENCODE_CONFIG_CONTENT='{"mcp": {...}}'` env
 * - opencode-acp: `mcpServers[]` in `session/new` / `session/load`
 * - codex: unsupported — rejects loudly (no silent ignore)
 */
export interface McpServer {
  /** Server name, unique per session. */
  name: string;
  /** Executable to spawn over stdio (absolute path or PATH name). */
  command: string;
  /** Argv for the server process. */
  args?: string[];
  /** Extra env for the server process (merged over the ambient env). */
  env?: Record<string, string>;
}

/**
 * Discovered MCP server — Phase 33 (query what the agent knows).
 * `command` may be absent when the agent only reports a name/status
 * (e.g. `claude mcp list` in a non-trusted dir). `status` is the
 * agent's own string (connected/disconnected/failed) — never a secret.
 */
export interface McpServerInfo {
  name: string;
  command?: string;
  status?: string;
  source?: string;
}
