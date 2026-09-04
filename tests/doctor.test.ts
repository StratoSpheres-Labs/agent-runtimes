import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor, doctorExitCode, formatReport, type DoctorReport } from "../src/doctor.js";
import { main } from "../src/cli.js";
import { RuntimeNotFoundError } from "../src/core/errors.js";

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
    expect(byName.get("MCP")?.status).toBe("warn");
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
  }, 30000);
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
