import { runCommand } from "./run-command.js";
import { resolveLaunch } from "./launch.js";
import type { McpServerInfo } from "../definition/mcp.js";

/**
 * Parse `opencode mcp list` / `claude mcp list` output.
 * The CLIs have no stable JSON flag, so we handle:
 * - JSON array/object with {name, command, status}
 * - Table / line output where each server is a line containing its name
 * Falls back to empty on unparseable output (never throws).
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
export function parseMcpList(stdout: string): McpServerInfo[] | null {
  const text = stdout.replace(ANSI_ESCAPE, "").trim();
  if (text.length === 0) return [];
  // Try JSON
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      const out: McpServerInfo[] = [];
      for (const e of parsed) {
        if (typeof e !== "object" || e === null) continue;
        const rec = e as Record<string, unknown>;
        const name =
          typeof rec["name"] === "string"
            ? rec["name"]
            : typeof rec["id"] === "string"
              ? rec["id"]
              : "";
        if (!name) continue;
        out.push({
          name,
          command: typeof rec["command"] === "string" ? rec["command"] : undefined,
          status: typeof rec["status"] === "string" ? rec["status"] : undefined,
          source: typeof rec["source"] === "string" ? rec["source"] : undefined,
        });
      }
      return out;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      const servers = rec["mcpServers"] ?? rec["servers"] ?? rec["mcp"];
      if (Array.isArray(servers)) {
        return parseMcpList(JSON.stringify(servers));
      }
      if (typeof rec["mcp"] === "object" && rec["mcp"] !== null) {
        const mcp = rec["mcp"] as Record<string, unknown>;
        return Object.keys(mcp).map((name) => ({ name, source: "config" }));
      }
    }
  } catch {
    // not JSON — fall through to line parsing
  }
  // Line/table fallback: look for lines that look like server entries
  // Heuristic: lines with a name and maybe a command/path, skip headers/separators
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const infos: McpServerInfo[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[^a-zA-Z0-9]+/, "").trim();
    // Skip obvious headers
    if (/^(name|server|mcp|connected|enabled)/i.test(line)) continue;
    if (/^[-=─]+$/.test(line)) continue;
    // Status words are capitalized by some CLIs (`✔ Connected`,
    // `✗ Failed`) — match case-insensitively, or the line below drops
    // claude's `name: <command> - <Status>` single-line shape as noise.
    const status = /connected/i.test(line)
      ? "connected"
      : /failed/i.test(line)
        ? "failed"
        : undefined;
    // For opencode's table, command lines like "npx -y ..." have no status — skip them
    // Only keep bullet/status lines; this avoids capturing the command as a server
    if (rawLine.includes("●") && status === undefined) continue;
    if (status === undefined && rawLine.includes("npx")) continue;
    // Try to extract first token as name
    const m = /^([a-zA-Z0-9_-]+)\b/.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    if (!name || name.length < 2) continue;
    // Avoid capturing generic words / spinner lines
    if (
      ["connected", "disconnected", "failed", "enabled", "disabled", "checking"].includes(
        name.toLowerCase(),
      )
    )
      continue;
    if (/^checking/i.test(line)) continue;
    infos.push({ name, status });
  }
  // If we found nothing but there was output, return empty (not null) to indicate "no servers" vs "unparseable"
  return infos.length > 0 ? infos : [];
}

export async function discoverMcp(
  executable: string,
  listCommand: string[],
  fallback: McpServerInfo[] = [],
): Promise<McpServerInfo[]> {
  // Shim-aware like model discovery (win32 npm `.cmd` needs host node).
  const launch = resolveLaunch(executable);
  const res = await runCommand({
    command: launch.command,
    args: [...launch.prependArgs, ...listCommand],
    env: launch.env,
  });
  if (res.timedOut || res.code !== 0) return fallback;
  const parsed = parseMcpList(`${res.stdout}\n${res.stderr}`);
  if (parsed === null) return fallback;
  return parsed;
}
