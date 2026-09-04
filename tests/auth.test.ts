import { describe, expect, it } from "vitest";
import { DefaultRuntime } from "../src/core/runtime.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import { parseOpencodeAuthList, probeOpencodeAuth } from "../runtimes/opencode/runtime.js";
import { parseClaudeAuthStatus, probeClaudeAuth } from "../runtimes/claude/runtime.js";
import { parseCodexLoginStatus, probeCodexAuth } from "../runtimes/codex/runtime.js";

// Modeled on real `opencode auth list` output (1.18.27), ANSI included.
const OPENCODE_SAMPLE =
  "\u001b[0m\n" +
  "\u001b[90m┌\u001b[39m  Credentials ~/.local/share/opencode/auth.json\n" +
  "\u001b[90m│\u001b[39m\n" +
  "\u001b[34m●\u001b[39m  Xiaomi Token Plan (China) \u001b[90mapi\n" +
  "\u001b[90m│\u001b[39m\n" +
  "\u001b[34m●\u001b[39m  Agnes AI \u001b[90mapi\n" +
  "\u001b[90m└\u001b[39m  2 credentials\n";

describe("parseOpencodeAuthList", () => {
  it("finds credentials through ANSI escapes", () => {
    expect(parseOpencodeAuthList(OPENCODE_SAMPLE)).toEqual({
      authenticated: true,
      method: "api-key",
      identities: ["Xiaomi Token Plan (China)", "Agnes AI"],
      detail: "2 opencode credential(s): Xiaomi Token Plan (China), Agnes AI",
    });
  });

  it("maps oauth kinds and zero credentials to logged-out", () => {
    expect(parseOpencodeAuthList("●  Zen oauth\n1 credentials\n").method).toBe("oauth");
    expect(parseOpencodeAuthList("  0 credentials\n")).toEqual({
      authenticated: false,
      method: "none",
      detail: "no opencode credentials — run `opencode auth login`",
    });
  });
});

describe("probeOpencodeAuth (hermetic)", () => {
  it("parses canned output through the full spawn path", async () => {
    const canned = "●  Canned api\n3 credentials";
    const res = await probeOpencodeAuth(process.execPath, [
      "-e",
      `console.log(${JSON.stringify(canned)})`,
    ]);
    expect(res.authenticated).toBe(true);
    expect(res.identities).toEqual(["Canned"]);
  });

  it("reports unknown (not logged-out) when the binary is missing", async () => {
    const res = await probeOpencodeAuth("definitely-not-a-binary-xyz");
    expect(res).toEqual({
      authenticated: false,
      method: "unknown",
      detail: "opencode auth probe could not start",
    });
  });
});

describe("parseClaudeAuthStatus", () => {
  it("maps the live JSON shape", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}',
      ),
    ).toEqual({
      authenticated: true,
      method: "oauth",
      identities: ["firstParty"],
      detail: "logged in via oauth_token",
    });
  });

  it("logged-out and garbage never read as logged-in", () => {
    expect(parseClaudeAuthStatus('{"loggedIn": false}')).toEqual({
      authenticated: false,
      method: "none",
      detail: "not logged in — run `claude auth login` or set ANTHROPIC_API_KEY",
    });
    expect(parseClaudeAuthStatus("not json").method).toBe("unknown");
    expect(parseClaudeAuthStatus("null").method).toBe("unknown");
  });
});

describe("probeClaudeAuth (hermetic)", () => {
  it("parses canned JSON through the full spawn path", async () => {
    const res = await probeClaudeAuth(process.execPath, [
      "-e",
      `console.log(${JSON.stringify('{"loggedIn": true, "authMethod": "api_key"}')})`,
    ]);
    expect(res).toEqual({
      authenticated: true,
      method: "api-key",
      identities: [],
      detail: "logged in via api_key",
    });
  });
});

describe("parseCodexLoginStatus", () => {
  it("maps the live shape and API-key variants", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT\n")).toEqual({
      authenticated: true,
      method: "oauth",
      identities: ["ChatGPT"],
      detail: "logged in using ChatGPT",
    });
    expect(parseCodexLoginStatus("Logged in using API key").method).toBe("api-key");
  });

  it("anything else is logged-out with fixed remediation text", () => {
    for (const out of ["Not logged in\n", ""]) {
      expect(parseCodexLoginStatus(out)).toEqual({
        authenticated: false,
        method: "none",
        detail: "not logged in — run `codex login` or set OPENAI_API_KEY",
      });
    }
  });
});

describe("probeCodexAuth (hermetic)", () => {
  it("parses canned output through the shim-aware launch", async () => {
    const res = await probeCodexAuth(process.execPath, [
      "-e",
      `console.log(${JSON.stringify("Logged in using ChatGPT")})`,
    ]);
    expect(res.authenticated).toBe(true);
    expect(res.method).toBe("oauth");
  });

  it("reads status from stderr (codex prints there)", async () => {
    const res = await probeCodexAuth(process.execPath, [
      "-e",
      `console.error(${JSON.stringify("Logged in using ChatGPT")})`,
    ]);
    expect(res.authenticated).toBe(true);
  });
});

describe("DefaultRuntime.auth", () => {
  it("stub reports unknown without probing", async () => {
    const runtime = new DefaultRuntime(opencodeDefinition);
    expect(await runtime.auth()).toEqual({
      authenticated: false,
      method: "unknown",
      detail: "generic runtime stub performs no auth probe",
    });
  });
});
