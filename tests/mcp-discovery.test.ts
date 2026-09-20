import { describe, expect, it } from "vitest";
import { parseMcpList } from "../src/discovery/mcp.js";
import { parseCodexMcpList } from "../runtimes/codex/definition.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";

describe("parseMcpList", () => {
  it("parses JSON array", () => {
    expect(parseMcpList('[{"name":"gh","command":"npx"},{"name":"echo"}]')).toEqual([
      { name: "gh", command: "npx" },
      { name: "echo" },
    ]);
  });
  it("parses table fallback", () => {
    const out = parseMcpList("gh   connected\nmy-mcp failed\n");
    expect(out?.map((s) => s.name)).toContain("gh");
    expect(out?.map((s) => s.name)).toContain("my-mcp");
  });
  it("parses claude's single-line shape with capitalized status", () => {
    // Verified shape (`claude mcp list`): name, inline command, and a
    // capitalized status on ONE line. The old case-sensitive match missed
    // "Connected", and the npx-noise guard then dropped the server.
    const out = parseMcpList(
      "Checking MCP server health…\n\ngithub: cmd /c npx -y @modelcontextprotocol/server-github - ✔ Connected\n",
    );
    expect(out).toEqual([{ name: "github", status: "connected" }]);
    const failed = parseMcpList("gh: npx -y something - ✗ Failed\n");
    expect(failed).toEqual([{ name: "gh", status: "failed" }]);
  });
  it("empty returns []", () => {
    expect(parseMcpList("")).toEqual([]);
  });
});

describe("parseCodexMcpList", () => {
  it("parses the Name/Command/Args/Env/Cwd/Status/Auth table", () => {
    const out = parseCodexMcpList(
      "Name      Command               Args                                  Env  Cwd  Status    Auth\n" +
        "github    npx                   -y @modelcontextprotocol/server-github  -    -    enabled   Unsupported\n" +
        "cua_repl  C:\\Tools\\ChatGPT.exe  -                                     -    -    disabled  Unsupported\n",
    );
    expect(out).toEqual([
      { name: "github", command: "npx", status: "enabled", source: "codex" },
      { name: "cua_repl", command: "C:\\Tools\\ChatGPT.exe", status: "disabled", source: "codex" },
    ]);
  });

  it("ignores header, rules, noise, and status-less lines", () => {
    expect(parseCodexMcpList("")).toEqual([]);
    expect(parseCodexMcpList("Name  Command  Args  Env  Cwd  Status  Auth\n")).toEqual([]);
    expect(parseCodexMcpList("Checking MCP server health…\n")).toEqual([]);
    expect(parseCodexMcpList("github  npx  -y something\n")).toEqual([]);
  });
});

describe("session.mcpServers (attached query)", () => {
  // createSession runs real detect() spawns — allow headroom under
  // full-suite load (default 5s vitest timeout flakes here).
  it("exposes what was passed at createSession", async () => {
    const rt = new (await import("../runtimes/opencode/runtime.js")).OpencodeRuntime();
    const sess = await rt.createSession({
      mcpServers: [{ name: "echo", command: "node", args: ["x"] }],
    });
    expect(sess.mcpServers?.map((s) => s.name)).toEqual(["echo"]);
    await sess.close();
  }, 30000);
});

describe("runtime.mcp() discovery", () => {
  it("codex lists live servers when installed", async () => {
    const rt = new CodexRuntime();
    const status = await rt.detect();
    if (!status.installed) {
      await expect(rt.mcp()).resolves.toEqual([]);
      return;
    }
    const servers = await rt.mcp();
    expect(Array.isArray(servers)).toBe(true);
    for (const s of servers) {
      expect(s.name.trim().length).toBeGreaterThan(0);
    }
  }, 30000);
});
