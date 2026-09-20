import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRuntime } from "../src/core/runtime.js";
import { opencodeDefinition } from "../runtimes/opencode/definition.js";
import {
  parseOpencodeAuthList,
  probeOpencodeAuth,
  readOpencodeAuthFile,
} from "../runtimes/opencode/runtime.js";
import { parseClaudeAuthStatus, probeClaudeAuth } from "../runtimes/claude/runtime.js";
import { parseCodexLoginStatus, probeCodexAuth } from "../runtimes/codex/runtime.js";
import { stderrTail, withStderrTail } from "../src/definition/auth.js";

describe("stderrTail", () => {
  it("takes the last non-empty line, capped at 200 chars", () => {
    expect(stderrTail("")).toBeNull();
    expect(stderrTail("  \n  ")).toBeNull();
    expect(stderrTail("first\nsecond\n")).toBe("second");
    const long = `x${"y".repeat(500)}`;
    const capped = stderrTail(long);
    expect(capped?.length).toBe(200);
    expect(long.startsWith(capped ?? "")).toBe(true);
  });

  it("withStderrTail leaves clean bases untouched", () => {
    expect(withStderrTail("base", "")).toBe("base");
    expect(withStderrTail("base", "boom")).toBe("base: boom");
  });
});

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
    // Isolated dataDir: the real ~/.local/share may contain auth.json on this
    // machine, which would (correctly) trigger the file fallback instead.
    const empty = mkdtempSync(join(tmpdir(), "opencode-auth-empty-"));
    try {
      const res = await probeOpencodeAuth("definitely-not-a-binary-xyz", [], {
        dataDir: empty,
      });
      expect(res).toEqual({
        authenticated: false,
        method: "unknown",
        detail: "opencode auth probe could not start",
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("attaches the stderr tail on probe failure (no auth.json fallback)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "opencode-auth-tail-"));
    try {
      const res = await probeOpencodeAuth(
        process.execPath,
        ["-e", "console.error('opencode: 401 Unauthorized'); process.exit(1)"],
        { dataDir: empty },
      );
      expect(res.authenticated).toBe(false);
      expect(res.detail).toContain("exit 1");
      expect(res.detail).toContain("opencode: 401 Unauthorized");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("falls back to auth.json when the CLI probe fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-auth-file-"));
    try {
      mkdirSync(join(dir, "opencode"), { recursive: true });
      // Fake key material — assertions only touch ids/types, never values.
      writeFileSync(
        join(dir, "opencode", "auth.json"),
        JSON.stringify({
          "fake-provider": { type: "api", key: "sk-fake-never-logged" },
          "fake-oauth": { type: "oauth", key: "tok-fake-never-logged" },
        }),
      );
      const res = await probeOpencodeAuth("definitely-not-a-binary-xyz", [], {
        dataDir: dir,
      });
      expect(res.authenticated).toBe(true);
      expect(res.method).toBe("oauth");
      expect(res.identities).toEqual(["fake-provider", "fake-oauth"]);
      expect(res.detail).not.toContain("sk-fake-never-logged");
      expect(res.detail).not.toContain("tok-fake-never-logged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readOpencodeAuthFile", () => {
  it("returns null for missing/malformed files", () => {
    const empty = mkdtempSync(join(tmpdir(), "opencode-auth-missing-"));
    try {
      expect(readOpencodeAuthFile({ dataDir: empty })).toBeNull();
      writeFileSync(join(empty, "auth.json"), "not json{{{");
      // Without the opencode/ subdir the file is not found either.
      expect(readOpencodeAuthFile({ dataDir: empty })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reads provider ids + types, never key material", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-auth-read-"));
    try {
      mkdirSync(join(dir, "opencode"), { recursive: true });
      writeFileSync(
        join(dir, "opencode", "auth.json"),
        JSON.stringify({ solo: { type: "api", key: "sk-fake-123" } }),
      );
      expect(readOpencodeAuthFile({ dataDir: dir })).toEqual({
        authenticated: true,
        method: "api-key",
        identities: ["solo"],
        detail: "1 opencode credential(s): solo (from auth.json)",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("attaches the stderr tail on probe failure", async () => {
    const res = await probeClaudeAuth(process.execPath, [
      "-e",
      "console.error('claude: command not found'); process.exit(1)",
    ]);
    expect(res.authenticated).toBe(false);
    expect(res.method).toBe("unknown");
    expect(res.detail).toContain("exit 1");
    expect(res.detail).toContain("claude: command not found");
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

  it("attaches the stderr tail on probe failure", async () => {
    const res = await probeCodexAuth(process.execPath, [
      "-e",
      "console.error('codex: missing credentials file'); process.exit(1)",
    ]);
    expect(res.authenticated).toBe(false);
    expect(res.detail).toContain("exit 1");
    expect(res.detail).toContain("codex: missing credentials file");
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
