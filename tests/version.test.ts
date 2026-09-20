import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver, probeVersion } from "../src/discovery/version.js";

describe("probeVersion", () => {
  it("reads node --version", async () => {
    const v = await probeVersion(process.execPath, ["--version"]);
    expect(v?.startsWith("v")).toBe(true);
  });

  it("forwards explicit env (shim launches merge harvested extras)", async () => {
    const v = await probeVersion(process.execPath, ["--version"], { ...process.env });
    expect(v?.startsWith("v")).toBe(true);
  });

  it("returns null for a missing command", async () => {
    await expect(probeVersion("definitely-not-exist-xyz", ["--version"])).resolves.toBeNull();
  });
});

describe("parseSemver", () => {
  it("extracts versions from prefixed/suffixed probe strings", () => {
    expect(parseSemver("codex-cli 0.150.1")).toEqual({ major: 0, minor: 150, patch: 1 });
    expect(parseSemver("2.1.187 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 187 });
    expect(parseSemver("1.18.30")).toEqual({ major: 1, minor: 18, patch: 30 });
  });

  it("fails open on prereleases and garbage", () => {
    expect(parseSemver("1.0.0-beta")).toBeNull();
    expect(parseSemver("no version here")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });

  it("orders versions numerically, not lexicographically", () => {
    const v150 = parseSemver("0.150.1");
    const v99 = parseSemver("0.99.0");
    expect(v150 && v99 && compareSemver(v150, v99)).toBeGreaterThan(0);
    expect(v150 && v99 && compareSemver(v99, v150)).toBeLessThan(0);
    const same = parseSemver("2.1.187 (Claude Code)");
    expect(same && compareSemver(same, { major: 2, minor: 1, patch: 187 })).toBe(0);
  });
});
