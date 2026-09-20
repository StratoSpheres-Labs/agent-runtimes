import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { buildAgentEnv } from "../src/discovery/env.js";

describe("buildAgentEnv proxy normalization", () => {
  it("mirrors the missing case without touching explicit pairs", () => {
    const lower = buildAgentEnv("opencode", { http_proxy: "http://proxy:8080" });
    expect(lower["http_proxy"]).toBe("http://proxy:8080");
    expect(lower["HTTP_PROXY"]).toBe("http://proxy:8080");

    const upper = buildAgentEnv("opencode", { HTTPS_PROXY: "https://proxy:8443" });
    expect(upper["HTTPS_PROXY"]).toBe("https://proxy:8443");
    expect(upper["https_proxy"]).toBe("https://proxy:8443");
  });

  it("leaves conflicting explicit pairs alone", () => {
    const out = buildAgentEnv("codex", {
      http_proxy: "http://a:1",
      HTTP_PROXY: "http://b:2",
    });
    expect(out["http_proxy"]).toBe("http://a:1");
    expect(out["HTTP_PROXY"]).toBe("http://b:2");
  });

  it("ignores absent and empty values", () => {
    const out = buildAgentEnv("claude", { NO_PROXY: "  " });
    expect("no_proxy" in out).toBe(false);
    expect("NO_PROXY" in out).toBe(true);
  });
});

describe("buildAgentEnv server-var stripping", () => {
  it("removes stale opencode server vars case-insensitively", () => {
    const out = buildAgentEnv("opencode", {
      OPENCODE_PID: "1",
      OPENCODE_PPID: "2",
      opencode_run_id: "abc",
      OpenCode_Server_Password: "secret",
      OPENCODE: "x",
      KEEP_ME: "yes",
    });
    for (const dead of [
      "OPENCODE_PID",
      "OPENCODE_PPID",
      "opencode_run_id",
      "OpenCode_Server_Password",
      "OPENCODE",
    ]) {
      expect(dead in out).toBe(false);
    }
    expect(out["KEEP_ME"]).toBe("yes");
    expect(out["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("true");
  });

  it("strips mimo server vars for the mimo agent only", () => {
    const mimo = buildAgentEnv("mimo", { MIMOCODE_RUN_ID: "x", OPENCODE_PID: "1" });
    expect("MIMOCODE_RUN_ID" in mimo).toBe(false);
    // OPENCODE_* stripping rides the shared opencode/mimo branch.
    expect("OPENCODE_PID" in mimo).toBe(false);
    const claude = buildAgentEnv("claude", { MIMOCODE_RUN_ID: "x" });
    expect(claude["MIMOCODE_RUN_ID"]).toBe("x");
  });
});

describe("buildAgentEnv home backfill", () => {
  it("fills Windows cache locations from USERPROFILE", () => {
    if (process.platform !== "win32") return;
    const out = buildAgentEnv("claude", { USERPROFILE: "C:\\Users\\someone" });
    expect(out["HOME"]).toBe("C:\\Users\\someone");
    expect(out["LOCALAPPDATA"]).toBe("C:\\Users\\someone\\AppData\\Local");
    expect(out["APPDATA"]).toBe("C:\\Users\\someone\\AppData\\Roaming");
    expect(out["TEMP"]).toBe("C:\\Users\\someone\\AppData\\Local\\Temp");
    expect(out["TMP"]).toBe("C:\\Users\\someone\\AppData\\Local\\Temp");
  });

  it("never overwrites explicit values", () => {
    if (process.platform !== "win32") return;
    const out = buildAgentEnv("claude", {
      USERPROFILE: "C:\\Users\\someone",
      TEMP: "D:\\custom-temp",
    });
    expect(out["TEMP"]).toBe("D:\\custom-temp");
    expect(out["TMP"]).toBe("C:\\Users\\someone\\AppData\\Local\\Temp");
  });

  it("reads oddly-cased keys on Windows without duplicating them", () => {
    if (process.platform !== "win32") return;
    const out = buildAgentEnv("claude", { home: "C:\\Users\\odd", Path: "C:\\y" });
    // Twin spelling carries the value (daemon parity: never rename user keys,
    // Windows folds them anyway); canonical keys are only ADDED when absent.
    expect(out["home"]).toBe("C:\\Users\\odd");
    expect("HOME" in out).toBe(false);
    expect(out["USERPROFILE"]).toBe("C:\\Users\\odd");
    expect(out["LOCALAPPDATA"]).toBe("C:\\Users\\odd\\AppData\\Local");
    // Existing key casing is preserved, never renamed.
    expect("Path" in out).toBe(true);
    expect("PATH" in out).toBe(false);
  });

  it("backfills HOME on posix", () => {
    if (process.platform === "win32") return;
    const out = buildAgentEnv("claude", {});
    expect(out["HOME"]?.length).toBeGreaterThan(0);
  });
});

describe("buildAgentEnv PATH", () => {
  it("keeps explicit PATH entries first and stays duplicate-free", () => {
    const out = buildAgentEnv("claude", { PATH: `/a${delimiter}/b` });
    const parts = (out["PATH"] ?? "").split(delimiter);
    expect(parts[0]).toBe("/a");
    expect(parts[1]).toBe("/b");
    expect(new Set(parts.map((p) => p.toLowerCase())).size).toBe(parts.length);
  });
});
