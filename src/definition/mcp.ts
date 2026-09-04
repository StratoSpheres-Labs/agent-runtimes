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
