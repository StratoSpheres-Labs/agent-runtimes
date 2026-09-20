import { describe, expect, it } from "vitest";
import {
  checkForUpdates,
  clearLatestCache,
  fetchLatestVersion,
  updateAvailable,
} from "../src/discovery/updates.js";
import { doctor } from "../src/doctor.js";
import type { InstalledCopy } from "../src/discovery/installs.js";
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

function copy(over: Partial<InstalledCopy> = {}): InstalledCopy {
  return {
    binary: "/usr/bin/tool",
    shims: ["/usr/bin/tool"],
    version: "1.0.0",
    manager: "npm",
    invocable: true,
    selected: true,
    ...over,
  };
}

describe("updateAvailable", () => {
  it("compares parsed semver strictly", () => {
    expect(updateAvailable("2.1.276 (Claude Code)", "2.1.277")).toBe(true);
    expect(updateAvailable("2.1.276", "2.1.276")).toBe(false);
    expect(updateAvailable("2.1.277", "2.1.276")).toBe(false);
    expect(updateAvailable("codex-cli 0.150.1", "0.151.0")).toBe(true);
  });

  it("fails open on unorderable versions (never nags)", () => {
    expect(updateAvailable("nightly-20240101", "nightly-20240201")).toBe(false);
    expect(updateAvailable("1.0.0", "latest")).toBe(false);
    expect(updateAvailable("", "2.0.0")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  it("returns null for unknown packages (never throws)", async () => {
    clearLatestCache();
    await expect(fetchLatestVersion("definitely-not-a-real-pkg-xyz-123")).resolves.toBeNull();
  }, 30000);

  it("reads a stub registry hermetically (no network)", async () => {
    clearLatestCache();
    const { server, url } = await stubRegistry({ "/%40scope/tool/latest": { version: "9.9.9" } });
    try {
      await expect(fetchLatestVersion("@scope/tool", { registry: url })).resolves.toBe("9.9.9");
      await expect(fetchLatestVersion("missing", { registry: url })).resolves.toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects garbage bodies without throwing", async () => {
    clearLatestCache();
    const { server, url } = await stubRegistryRaw("/weird/latest", "not json{{{");
    try {
      await expect(fetchLatestVersion("weird", { registry: url })).resolves.toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});

describe("checkForUpdates", () => {
  it("returns null without a registryId (not checkable, not an error)", async () => {
    await expect(checkForUpdates([copy()])).resolves.toBeNull();
    await expect(checkForUpdates([copy()], undefined)).resolves.toBeNull();
  });

  it("skips unversioned and dead copies", async () => {
    clearLatestCache();
    const infos = await checkForUpdates(
      [copy({ version: null }), copy({ invocable: false }), copy({ version: "0.0.1" })],
      "@anthropic-ai/claude-code",
    );
    if (!infos) return; // offline: registry unreachable, fail-open
    expect(infos).toHaveLength(1);
    expect(infos[0]?.updateAvailable).toBe(true); // registry is always past 0.0.1
    expect(infos[0]?.latest).toMatch(/\d+\.\d+\.\d+/);
  }, 60000);

  it("caches the registry hit (second call needs no network)", async () => {
    clearLatestCache();
    const first = await fetchLatestVersion("@anthropic-ai/claude-code");
    if (!first) return; // offline
    // Poison the cache directly is impossible from outside — instead assert
    // the second call resolves to the same value without asserting timing.
    await expect(fetchLatestVersion("@anthropic-ai/claude-code")).resolves.toBe(first);
  }, 60000);

  it("compares hermetically against a stub registry", async () => {
    clearLatestCache();
    const { server, url } = await stubRegistry({ "/tool/latest": { version: "2.0.0" } });
    try {
      const opts = { registry: url };
      const infos = await checkForUpdates(
        [copy({ version: "1.0.0" }), copy({ version: null }), copy({ invocable: false })],
        "tool",
        opts,
      );
      expect(infos).toHaveLength(1);
      expect(infos?.[0]).toMatchObject({
        manager: "npm",
        installed: "1.0.0",
        latest: "2.0.0",
        updateAvailable: true,
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe("doctor Version row update suffix", () => {
  it("leaves the Version row plain without a registryId (zero network)", async () => {
    // The stub below has installs but no registryId — nothing to check
    // against, so the row stays a plain version.
    const rt = stubRuntime();
    const report = await doctor("stub", fakeRegistry(rt));
    expect(report.checks.find((c) => c.name === "Version")?.detail).toBe("1.0.0");
  });

  it("appends → latest when the selected copy lags the registry", async () => {
    clearLatestCache();
    const latest = await fetchLatestVersion("@anthropic-ai/claude-code");
    if (!latest) return; // offline
    const rt = stubRuntime();
    const base = rt.info();
    rt.info = () => ({ ...base, registryId: "@anthropic-ai/claude-code" });
    const report = await doctor("stub", fakeRegistry(rt));
    const row = report.checks.find((c) => c.name === "Version");
    expect(row?.status).toBe("warn");
    expect(row?.reason).toBe("update-available");
    expect(row?.detail).toMatch(/^1\.0\.0 → \d+\.\d+\.\d+$/);
  }, 60000);

  it("keeps untested-version precedence with the suffix attached", async () => {
    clearLatestCache();
    const latest = await fetchLatestVersion("@anthropic-ai/claude-code");
    if (!latest) return; // offline
    const rt = stubRuntime();
    const base = rt.info();
    rt.info = () => ({
      ...base,
      registryId: "@anthropic-ai/claude-code",
      versionPolicy: { minimum: "9.9.9" },
    });
    const report = await doctor("stub", fakeRegistry(rt));
    const row = report.checks.find((c) => c.name === "Version");
    expect(row?.status).toBe("warn");
    expect(row?.reason).toBe("untested-version");
    expect(row?.detail).toContain("→");
  }, 60000);
});

// --- local stubs (mirror doctor.test.ts healthyStub, plus installs) ---

const ALL_CAPS: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: true,
  workspace: true,
};

function stubRuntime(): AgentRuntime {
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
    mcp: (): Promise<McpServerInfo[]> => Promise.resolve([]),
    skills: (): Promise<RuntimeSkill[]> => Promise.resolve([]),
    plugins: (): Promise<RuntimePlugin[]> => Promise.resolve([]),
    installs: (): Promise<InstalledCopy[]> =>
      Promise.resolve([copy({ version: "0.0.1", manager: "npm" })]),
  };
}

function fakeRegistry(rt: AgentRuntime): Pick<RuntimeRegistry, "resolve"> {
  return { resolve: (_id: string): Promise<AgentRuntime> => Promise.resolve(rt) };
}

// --- hermetic registry stub (node:http, localhost only) ---

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function stubRegistry(
  routes: Record<string, unknown>,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json").end(JSON.stringify(body));
  });
  return { server, url: await listen(server) };
}

async function stubRegistryRaw(
  path: string,
  body: string,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    res.end(body);
  });
  return { server, url: await listen(server) };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(addr.port)}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
