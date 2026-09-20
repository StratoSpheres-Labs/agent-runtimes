import { afterEach, describe, expect, it, vi } from "vitest";
import {
  doctor,
  doctorExitCode,
  formatReport,
  summarizeModels,
  type DoctorReason,
  type DoctorReport,
} from "../src/doctor.js";
import { main } from "../src/cli.js";
import { RuntimeNotFoundError } from "../src/core/errors.js";
import type {
  AgentRuntime,
  AgentSession,
  RuntimeInfo,
  RuntimeStatus,
} from "../src/core/runtime.js";
import type { RuntimeRegistry } from "../src/core/registry.js";
import type { RuntimeCapabilities } from "../src/definition/capability.js";
import type { AuthStatus } from "../src/definition/auth.js";
import type { RuntimeModel } from "../src/definition/model.js";
import type { McpServerInfo } from "../src/definition/mcp.js";
import type { RuntimeSkill } from "../src/definition/skill.js";
import type { RuntimePlugin } from "../src/definition/plugin.js";
import type { InstalledCopy } from "../src/discovery/installs.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeReport(): DoctorReport {
  return {
    id: "opencode",
    name: "OpenCode",
    checks: [
      { name: "Executable", status: "ok", detail: "/usr/local/bin/opencode" },
      { name: "MCP", status: "warn", detail: "deferred to v0.2" },
      { name: "Image Input", status: "fail", detail: "not supported" },
    ],
  };
}

describe("formatReport / doctorExitCode", () => {
  it("renders one padded row per check with glyphs", () => {
    const out = formatReport(fakeReport());
    expect(out).toContain("Agent Runtime Doctor");
    expect(out).toContain("OpenCode");
    expect(out).toContain("✓");
    expect(out).toContain("⚠");
    expect(out).toContain("✗");
    expect(out).toContain("/usr/local/bin/opencode");
  });

  it("exits nonzero only for run-blocking failures", () => {
    // Image Input fails on every current adapter — that must not turn red.
    expect(doctorExitCode(fakeReport())).toBe(0);
    expect(
      doctorExitCode({
        id: "x",
        name: "X",
        checks: [{ name: "Executable", status: "fail", detail: "missing" }],
      }),
    ).toBe(1);
    expect(
      doctorExitCode({
        id: "x",
        name: "X",
        checks: [
          { name: "Executable", status: "ok", detail: "" },
          { name: "Version", status: "warn", detail: "" },
        ],
      }),
    ).toBe(0);
  });
});

describe("doctor()", () => {
  it("rejects unknown runtime ids like resolve does", async () => {
    await expect(doctor("definitely-not-a-runtime")).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });

  it("reports opencode health (live where installed)", async () => {
    const report = await doctor("opencode");
    expect(report.id).toBe("opencode");
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    // Static rows hold regardless of installation.
    expect(byName.get("Streaming")?.status).toBe("ok");
    // Live auth state varies (this machine is logged in) — accept ok/warn
    // but never the old deferred placeholder.
    expect(["ok", "warn"]).toContain(byName.get("Authentication")?.status);
    expect(byName.get("Authentication")?.detail).not.toContain("deferred (Phase 22)");
    // Live MCP state varies (this machine has a connected github server) —
    // ok with server names, or warn when none.
    expect(["ok", "warn"]).toContain(byName.get("MCP")?.status);
    if (byName.get("MCP")?.status === "ok") {
      expect(byName.get("MCP")?.detail).toContain("server(s):");
    }
    // Model always resolves (live list or static fallback).
    expect(byName.get("Model")?.status).toBe("ok");
    const exe = byName.get("Executable");
    if (exe?.status === "ok") {
      expect(typeof exe.detail).toBe("string");
      expect(["ok", "warn"]).toContain(byName.get("Version")?.status);
    } else {
      expect(exe?.status).toBe("fail");
      expect(byName.get("Version")?.status).toBe("fail");
    }
    // Full doctor fans out to detect/auth/models(verbose+plain)/mcp — every
    // leg can hit the network, so allow headroom on slow links.
  }, 60000);

  it("reports codex models honestly (live list or unknown, never stale)", async () => {
    const report = await doctor("codex");
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    const model = byName.get("Model");
    // Installed → live `debug models`; missing/broken → warn "unknown".
    // Either way a stale static list must never masquerade as live data.
    expect(["ok", "warn"]).toContain(model?.status);
    if (model?.status === "ok") {
      expect(model.detail).toMatch(/\d+ model\(s\) across \d+ providers?: /);
    } else {
      expect(model?.detail).toContain("unknown");
    }
  }, 30000);
});

describe("summarizeModels", () => {
  it("lists distinct providers so config-declared ones stay visible", () => {
    expect(
      summarizeModels([
        { id: "opencode/gpt-5" },
        { id: "opencode/gpt-5-mini" },
        { id: "bai/deepseek-v4-flash", provider: "bai" },
      ]),
    ).toBe("3 model(s) across 2 providers: bai, opencode");
  });

  it("uses singular for one provider and falls back without provider info", () => {
    expect(summarizeModels([{ id: "gpt-5", provider: "openai" }])).toBe(
      "1 model(s) across 1 provider: openai",
    );
    expect(summarizeModels([{ id: "x" }])).toBe("1 model(s)");
  });
});

describe("cli main()", () => {
  it("prints usage and exits 2 without args", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main([])).resolves.toBe(2);
    expect(log.mock.calls.join("\n")).toContain("Usage:");
  });

  it("exits 1 for unknown runtime ids", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["doctor", "definitely-not-a-runtime"])).resolves.toBe(1);
    expect(err.mock.calls.join("\n")).toContain("error:");
  });
});

const ALL_CAPS: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: true,
  workspace: true,
};

function healthyStub(): AgentRuntime {
  return {
    id: "stub",
    info: (): RuntimeInfo => ({ id: "stub", name: "Stub", capabilities: ALL_CAPS }),
    detect: (): Promise<RuntimeStatus> =>
      Promise.resolve({ installed: true, executable: "/usr/bin/stub", version: "1.0.0" }),
    createSession: (): Promise<AgentSession> => Promise.reject(new Error("unused in doctor")),
    capabilities: (): RuntimeCapabilities => ALL_CAPS,
    models: (): Promise<RuntimeModel[]> => Promise.resolve([{ id: "m" }]),
    auth: (): Promise<AuthStatus> =>
      Promise.resolve({ authenticated: true, method: "oauth", detail: "ok" }),
    mcp: (): Promise<McpServerInfo[]> => Promise.resolve([{ name: "s" }]),
    skills: (): Promise<RuntimeSkill[]> => Promise.resolve([]),
    plugins: (): Promise<RuntimePlugin[]> => Promise.resolve([]),
    installs: (): Promise<InstalledCopy[]> => Promise.resolve([]),
  };
}

function fakeRegistry(rt: AgentRuntime): Pick<RuntimeRegistry, "resolve"> {
  return { resolve: (_id: string): Promise<AgentRuntime> => Promise.resolve(rt) };
}

function reasonOf(report: DoctorReport, name: string): DoctorReason | undefined {
  return report.checks.find((c) => c.name === name)?.reason;
}

describe("doctor() reason codes (stub runtimes, no CLI)", () => {
  it("marks a missing runtime not-on-path", async () => {
    const rt = healthyStub();
    rt.detect = () => Promise.resolve({ installed: false });
    const report = await doctor("stub", fakeRegistry(rt));
    expect(reasonOf(report, "Executable")).toBe("not-on-path");
    expect(reasonOf(report, "Version")).toBe("not-on-path");
    expect(report.checks.find((c) => c.name === "Executable")?.status).toBe("fail");
    const searched = report.checks.find((c) => c.name === "Executable")?.searchedDirs;
    expect(Array.isArray(searched)).toBe(true);
    expect((searched ?? []).length).toBeGreaterThan(0);
    expect(formatReport(report)).toContain("looked in:");
  });

  it("flags unprobable .cmd shims as shim-broken, other binaries as version-probe-failed", async () => {
    const shim = healthyStub();
    shim.detect = () =>
      Promise.resolve({ installed: true, executable: "C:\\tools\\codex.cmd", version: null });
    const shimReport = await doctor("stub", fakeRegistry(shim));
    expect(reasonOf(shimReport, "Version")).toBe("shim-broken");

    const native = healthyStub();
    native.detect = () =>
      Promise.resolve({ installed: true, executable: "/usr/bin/stub", version: null });
    const nativeReport = await doctor("stub", fakeRegistry(native));
    expect(reasonOf(nativeReport, "Version")).toBe("version-probe-failed");
  });

  it("distinguishes auth-missing (logged out) from auth-unknown (probe failed)", async () => {
    const loggedOut = healthyStub();
    loggedOut.auth = () =>
      Promise.resolve({ authenticated: false, method: "none", detail: "run login" });
    expect(reasonOf(await doctor("stub", fakeRegistry(loggedOut)), "Authentication")).toBe(
      "auth-missing",
    );

    const unknown = healthyStub();
    unknown.auth = () =>
      Promise.resolve({ authenticated: false, method: "unknown", detail: "probe blew up" });
    expect(reasonOf(await doctor("stub", fakeRegistry(unknown)), "Authentication")).toBe(
      "auth-unknown",
    );

    const threw = healthyStub();
    threw.auth = () => Promise.reject(new Error("spawn ENOENT"));
    const threwReport = await doctor("stub", fakeRegistry(threw));
    expect(reasonOf(threwReport, "Authentication")).toBe("auth-unknown");
    expect(threwReport.checks.find((c) => c.name === "Authentication")?.detail).toContain(
      "spawn ENOENT",
    );
  });

  it("marks empty model lists unknown but probe errors failed", async () => {
    const empty = healthyStub();
    empty.models = () => Promise.resolve([]);
    const emptyReport = await doctor("stub", fakeRegistry(empty));
    expect(reasonOf(emptyReport, "Model")).toBe("model-list-unknown");
    expect(emptyReport.checks.find((c) => c.name === "Model")?.status).toBe("warn");

    const threw = healthyStub();
    threw.models = () => Promise.reject(new Error("boom"));
    const threwReport = await doctor("stub", fakeRegistry(threw));
    expect(reasonOf(threwReport, "Model")).toBe("model-probe-failed");
    expect(threwReport.checks.find((c) => c.name === "Model")?.status).toBe("fail");
  });

  it("marks missing capabilities unsupported and healthy rows reasonless", async () => {
    const rt = healthyStub();
    rt.capabilities = (): RuntimeCapabilities => ({ ...ALL_CAPS, workspace: false });
    const report = await doctor("stub", fakeRegistry(rt));
    expect(reasonOf(report, "Workspace")).toBe("unsupported");
    expect(reasonOf(report, "Streaming")).toBeUndefined();
    expect(reasonOf(report, "Model")).toBeUndefined();
  });

  it("marks empty MCP lists mcp-empty and MCP errors mcp-unknown", async () => {
    const empty = healthyStub();
    empty.mcp = () => Promise.resolve([]);
    expect(reasonOf(await doctor("stub", fakeRegistry(empty)), "MCP")).toBe("mcp-empty");

    const threw = healthyStub();
    threw.mcp = () => Promise.reject(new Error("nope"));
    expect(reasonOf(await doctor("stub", fakeRegistry(threw)), "MCP")).toBe("mcp-unknown");
  });

  it("renders reason codes inline in formatReport", () => {
    const out = formatReport({
      id: "x",
      name: "X",
      checks: [
        {
          name: "Version",
          status: "warn",
          detail: "installed, version unknown",
          reason: "shim-broken",
        },
        { name: "Model", status: "ok", detail: "1 model(s)" },
      ],
    });
    expect(out).toContain("[shim-broken]");
    expect(out).not.toContain("[undefined]");
  });

  it("formats the Installs row compactly (semver short, flags inline)", async () => {
    const { formatInstalls } = await import("../src/doctor.js");
    expect(
      formatInstalls([
        {
          binary: "a",
          shims: ["a"],
          version: "2.1.276 (Claude Code)",
          manager: "pnpm",
          invocable: true,
          selected: true,
        },
        {
          binary: "b",
          shims: ["b"],
          version: null,
          manager: "npm",
          invocable: false,
          selected: false,
        },
      ]),
    ).toBe("pnpm 2.1.276 (selected), npm unknown (unusable)");
  });

  it("lists installs on the doctor report when the runtime provides them", async () => {
    const rt = healthyStub();
    rt.installs = () =>
      Promise.resolve([
        {
          binary: "a",
          shims: ["a"],
          version: "1.0.0",
          manager: "npm",
          invocable: true,
          selected: true,
        },
      ]);
    const report = await doctor("stub", fakeRegistry(rt));
    expect(report.checks.find((c) => c.name === "Installs")?.detail).toBe("npm 1.0.0 (selected)");
  });

  it("warns untested-version below the floor or older than tested", async () => {
    const policy = { minimum: "0.143.0", tested: ["0.150.1"] };
    const at = (version: string): AgentRuntime => {
      const rt = healthyStub();
      rt.detect = () => Promise.resolve({ installed: true, executable: "/usr/bin/stub", version });
      rt.info = (): RuntimeInfo => ({
        id: "stub",
        name: "Stub",
        capabilities: ALL_CAPS,
        versionPolicy: policy,
      });
      return rt;
    };
    const old = await doctor("stub", fakeRegistry(at("codex-cli 0.142.0")));
    expect(reasonOf(old, "Version")).toBe("untested-version");
    expect(old.checks.find((c) => c.name === "Version")?.status).toBe("warn");
    expect(old.checks.find((c) => c.name === "Version")?.detail).toContain("0.143.0");

    const tested = await doctor("stub", fakeRegistry(at("codex-cli 0.150.1")));
    expect(reasonOf(tested, "Version")).toBeUndefined();

    // Newer than everything tested fails open (never punish upgrades).
    const newer = await doctor("stub", fakeRegistry(at("codex-cli 0.999.0")));
    expect(reasonOf(newer, "Version")).toBeUndefined();

    // No policy means can't judge — always ok.
    const bare = healthyStub();
    bare.detect = () =>
      Promise.resolve({ installed: true, executable: "/usr/bin/stub", version: "0.0.1" });
    expect(reasonOf(await doctor("stub", fakeRegistry(bare)), "Version")).toBeUndefined();
  });
});
