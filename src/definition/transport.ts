/**
 * How the host communicates with the Agent CLI.
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md Task 1.4
 * Phase 20 adds ACP (JSON-RPC over stdio); future: websocket, http.
 */
export interface TransportDefinition {
  type: "stdio" | "acp";
}
