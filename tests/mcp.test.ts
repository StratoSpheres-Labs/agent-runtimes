import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  buildClaudeArgs,
  buildClaudeMcpAllowedTools,
  buildClaudeMcpConfig,
  writeClaudeMcpConfigFile,
} from "../runtimes/claude/definition.js";
import { ClaudeSession } from "../runtimes/claude/session.js";
import { buildOpencodeMcpConfig } from "../runtimes/opencode/definition.js";
import { OpencodeSession } from "../runtimes/opencode/session.js";
import { buildAcpMcpServers } from "../src/transport/acp.js";
import { CodexSession } from "../runtimes/codex/session.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import type { McpServer } from "../src/definition/mcp.js";

const echoServer: McpServer = {
  name: "echo",
  command: process.execPath,
  args: ["echo.mjs"],
  env: { ECHO_PREFIX: "P:" },
};

describe("buildClaudeMcpConfig", () => {
  it("renders the .mcp.json shape with a string command", () => {
    expect(JSON.parse(buildClaudeMcpConfig([echoServer]))).toEqual({
      mcpServers: {
        echo: {
          command: process.execPath,
          args: ["echo.mjs"],
          env: { ECHO_PREFIX: "P:" },
        },
      },
    });
  });

  it("omits empty args/env and handles no servers", () => {
    expect(JSON.parse(buildClaudeMcpConfig([{ name: "bare", command: "uvx" }]))).toEqual({
      mcpServers: { bare: { command: "uvx" } },
    });
    expect(buildClaudeMcpConfig([])).toBe('{"mcpServers":{}}');
  });

  it("feeds --mcp-config through buildClaudeArgs", () => {
    const args = buildClaudeArgs({ mcpConfigFile: "C:\\mcp.json" });
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("C:\\mcp.json");
  });

  it("derives scoped --allowedTools from servers", () => {
    expect(
      buildClaudeMcpAllowedTools([echoServer, { name: "gh", command: "x" }]),
    ).toEqual(["mcp__echo__*", "mcp__gh__*"]);
    const args = buildClaudeArgs({ allowedTools: ["mcp__echo__*", "mcp__gh__*"] });
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__echo__* mcp__gh__*");
  });
});

describe("writeClaudeMcpConfigFile", () => {
  it("writes a parseable temp file", () => {
    const file = writeClaudeMcpConfigFile([echoServer], "unit");
    try {
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(
        JSON.parse(buildClaudeMcpConfig([echoServer])),
      );
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("buildOpencodeMcpConfig", () => {
  it("renders local servers with an array command", () => {
    expect(JSON.parse(buildOpencodeMcpConfig([echoServer]))).toEqual({
      mcp: {
        echo: {
          type: "local",
          command: [process.execPath, "echo.mjs"],
          enabled: true,
          environment: { ECHO_PREFIX: "P:" },
        },
      },
    });
  });

  it("omits an empty environment and handles no servers", () => {
    expect(JSON.parse(buildOpencodeMcpConfig([{ name: "bare", command: "npx" }]))).toEqual({
      mcp: { bare: { type: "local", command: ["npx"], enabled: true } },
    });
    expect(buildOpencodeMcpConfig([])).toBe('{"mcp":{}}');
  });
});

describe("buildAcpMcpServers", () => {
  it("maps the env record to name/value pairs with arg/env defaults", () => {
    expect(buildAcpMcpServers([echoServer])).toEqual([
      {
        name: "echo",
        command: process.execPath,
        args: ["echo.mjs"],
        env: [{ name: "ECHO_PREFIX", value: "P:" }],
      },
    ]);
    expect(buildAcpMcpServers([{ name: "bare", command: "x" }])).toEqual([
      { name: "bare", command: "x", args: [], env: [] },
    ]);
  });
});

describe("codex MCP rejection", () => {
  it("CodexSession.run rejects loudly when servers are configured", async () => {
    const sess = new CodexSession({
      id: "mcp_no",
      command: process.execPath,
      mcpServers: [echoServer],
    });
    await expect(sess.run("hi")).rejects.toThrow(/MCP servers/);
    await sess.close();
  });

  it("CodexRuntime.createSession rejects fast without probing", async () => {
    const runtime = new CodexRuntime();
    await expect(runtime.createSession({ mcpServers: [echoServer] })).rejects.toBeInstanceOf(
      RuntimeSessionError,
    );
  });
});

describe("MCP session smoke (no spawn)", () => {
  it("ClaudeSession with servers closes cleanly before any run", async () => {
    const sess = new ClaudeSession({
      id: "mcp_smoke",
      command: process.execPath,
      mcpServers: [echoServer],
    });
    await sess.close();
  });

  it("OpencodeSession with servers closes cleanly before any run", async () => {
    const sess = new OpencodeSession({
      id: "mcp_smoke",
      command: process.execPath,
      mcpServers: [echoServer],
    });
    await sess.close();
  });
});
