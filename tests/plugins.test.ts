import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  discoverPlugins,
  parsePluginEntries,
  pluginConfigFiles,
  pluginSearchDirs,
  readPluginConfigFile,
  stripJsoncComments,
} from "../src/discovery/plugins.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import {
  ClaudeRuntime,
  parseClaudePluginList,
  probeClaudePlugins,
  readClaudePluginsFile,
} from "../runtimes/claude/runtime.js";
import {
  CodexRuntime,
  parseCodexPluginList,
  probeCodexPlugins,
} from "../runtimes/codex/runtime.js";
import { readCodexPluginsFile } from "../runtimes/codex/definition.js";
import { doctor } from "../src/doctor.js";

function writeConfig(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf-8");
}

describe("stripJsoncComments", () => {
  it("removes line and block comments, keeps strings intact", () => {
    const out = stripJsoncComments(
      '{\n// a comment\n"a": "x // not a comment", /* block */ "b": 1\n}',
    );
    expect(JSON.parse(out)).toEqual({ a: "x // not a comment", b: 1 });
  });
});

describe("parsePluginEntries", () => {
  it("reads strings and [name, config] tuples, skips the rest", () => {
    expect(
      parsePluginEntries(
        ["opencode-helicone-session", ["@my-org/custom-plugin", { key: "v" }], 42, null, ""],
        "global",
      ),
    ).toEqual([
      { id: "opencode-helicone-session", source: "global", kind: "npm" },
      { id: "@my-org/custom-plugin", source: "global", kind: "npm", hasConfig: true },
    ]);
  });

  it("returns [] for non-arrays", () => {
    expect(parsePluginEntries(undefined, "global")).toEqual([]);
    expect(parsePluginEntries({ plugin: [] }, "global")).toEqual([]);
  });
});

describe("pluginConfigFiles / pluginSearchDirs", () => {
  it("lists global + project paths without spawning", () => {
    const files = pluginConfigFiles({ homeDir: "/tmp/fake-home", cwd: "/tmp/fake-proj" });
    expect(files.map((f) => f.file)).toContain(
      join("/tmp/fake-home", ".config", "opencode", "opencode.json"),
    );
    expect(files.map((f) => f.file)).toContain(resolve("/tmp/fake-proj", "opencode.json"));
    expect(files.find((f) => f.source === "project")).toBeDefined();
    const dirs = pluginSearchDirs({ homeDir: "/tmp/fake-home", cwd: "/tmp/fake-proj" });
    expect(dirs).toHaveLength(2);
    expect(dirs[1]).toEqual({
      dir: resolve("/tmp/fake-proj", ".opencode", "plugins"),
      source: "project",
    });
  });
});

describe("readPluginConfigFile", () => {
  it("reads JSONC with comments and trailing commas", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-plugins-"));
    try {
      const file = join(base, "opencode.jsonc");
      writeConfig(
        file,
        '{\n// comment\n"plugin": [\n"a-plugin",\n["b-plugin", {"k": "v"}],\n],\n}\n',
      );
      expect(readPluginConfigFile({ file, source: "global" })).toEqual([
        { id: "a-plugin", source: "global", kind: "npm" },
        { id: "b-plugin", source: "global", kind: "npm", hasConfig: true },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns [] for missing/garbage files (fail-open)", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-plugins-"));
    try {
      const missing = join(base, "nope.json");
      expect(readPluginConfigFile({ file: missing, source: "global" })).toEqual([]);
      const garbage = join(base, "garbage.json");
      writeConfig(garbage, "not json at all {{{");
      expect(readPluginConfigFile({ file: garbage, source: "global" })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("discoverPlugins", () => {
  it("merges config arrays (explicit wins) with local dirs, deduped", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-plugins-"));
    try {
      const globalConfig = join(base, "home", ".config", "opencode", "opencode.json");
      writeConfig(globalConfig, JSON.stringify({ plugin: ["npm-plugin", ["tuple-plugin", {}]] }));
      const projConfig = join(base, "proj", "opencode.json");
      writeConfig(projConfig, JSON.stringify({ plugin: ["npm-plugin"] }));
      const globalDir = join(base, "home", ".config", "opencode", "plugins");
      mkdirSync(join(globalDir, "local-plugin"), { recursive: true });
      // Loose files are not plugins — only directories count.
      writeFileSync(join(globalDir, "loose.txt"), "x", "utf-8");
      // Same id as the config entry (different case) → config wins, one row.
      mkdirSync(join(globalDir, "NPM-Plugin"), { recursive: true });
      const out = discoverPlugins(
        pluginConfigFiles({ homeDir: join(base, "home"), cwd: join(base, "proj") }),
        pluginSearchDirs({ homeDir: join(base, "home"), cwd: join(base, "proj") }),
      );
      expect(out).toEqual([
        { id: "npm-plugin", source: "global", kind: "npm" },
        { id: "tuple-plugin", source: "global", kind: "npm", hasConfig: true },
        { id: "npm-plugin", source: "project", kind: "npm" },
        { id: "local-plugin", source: "global", kind: "local" },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("parseClaudePluginList", () => {
  // Shape verified on claude 2.1.187 (paths anonymized); installPath is
  // deliberately dropped — machine layout, not plugin metadata.
  const LIST_JSON = JSON.stringify([
    {
      id: "claude-hud@claude-hud",
      version: "0.0.11",
      scope: "project",
      enabled: false,
      installPath: "C:\\x\\.claude\\plugins\\cache\\claude-hud\\claude-hud\\0.0.11",
      installedAt: "2026-03-26T03:10:27.746Z",
      projectPath: "C:\\x\\Desktop\\aeris-cli",
    },
    {
      id: "codex@openai-codex",
      version: "1.0.5",
      scope: "user",
      enabled: true,
      installPath: "C:\\x\\.claude\\plugins\\cache\\openai-codex\\codex\\1.0.5",
    },
    { id: "", scope: "user" },
    "not-an-object",
  ]);

  it("maps ids, scope, version, and enabled state", () => {
    expect(parseClaudePluginList(LIST_JSON)).toEqual([
      {
        id: "claude-hud@claude-hud",
        source: "project",
        kind: "marketplace",
        version: "0.0.11",
        enabled: false,
        projectPath: "C:\\x\\Desktop\\aeris-cli",
      },
      {
        id: "codex@openai-codex",
        source: "global",
        kind: "marketplace",
        version: "1.0.5",
        enabled: true,
      },
    ]);
  });

  it("returns null for unparseable output (caller falls back to file)", () => {
    expect(parseClaudePluginList("not json")).toBeNull();
    expect(parseClaudePluginList('{"not":"an array"}')).toBeNull();
  });

  it("returns [] for an empty list", () => {
    expect(parseClaudePluginList("[]")).toEqual([]);
  });
});

describe("readClaudePluginsFile", () => {
  it("reads installed_plugins.json keyed by id", () => {
    const base = mkdtempSync(join(tmpdir(), "claude-plugins-file-"));
    try {
      const pluginsDir = join(base, ".claude", "plugins");
      writeConfig(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "codex@openai-codex": [{ scope: "user", version: "1.0.5" }],
          },
        }),
      );
      expect(readClaudePluginsFile({ homeDir: base })).toEqual([
        { id: "codex@openai-codex", source: "global", kind: "marketplace", version: "1.0.5" },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing (not an error)", () => {
    const base = mkdtempSync(join(tmpdir(), "claude-plugins-missing-"));
    try {
      expect(readClaudePluginsFile({ homeDir: base })).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("probeClaudePlugins (hermetic)", () => {
  it("parses canned output through the full spawn path", async () => {
    const canned = JSON.stringify([{ id: "canned@market", scope: "user", enabled: true }]);
    const empty = mkdtempSync(join(tmpdir(), "claude-plugins-canned-"));
    try {
      const res = await probeClaudePlugins(
        process.execPath,
        ["-e", `console.log(${JSON.stringify(canned)})`],
        { homeDir: empty },
      );
      expect(res).toEqual([
        { id: "canned@market", source: "global", kind: "marketplace", enabled: true },
      ]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("falls back to installed_plugins.json when the CLI probe fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "claude-plugins-fallback-"));
    try {
      writeConfig(
        join(base, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "file@market": [{ scope: "user" }] } }),
      );
      const res = await probeClaudePlugins("definitely-not-a-binary-xyz", [], {
        homeDir: base,
      });
      expect(res).toEqual([{ id: "file@market", source: "global", kind: "marketplace" }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("ClaudeRuntime.plugins", () => {
  it("lists live plugins when installed (codex@openai-codex)", async () => {
    if (!existsSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"))) return;
    const runtime = new ClaudeRuntime();
    const plugins = await runtime.plugins();
    expect(plugins.map((p) => p.id)).toContain("codex@openai-codex");
    expect(plugins.every((p) => p.kind === "marketplace")).toBe(true);
  }, 15000);
});

describe("parseCodexPluginList", () => {
  // Shape verified on codex-cli 0.150.1 (paths anonymized); PATH objects
  // are deliberately dropped — machine layout, not plugin metadata.
  const LIST_JSON = JSON.stringify({
    installed: [
      {
        pluginId: "documents@openai-primary-runtime",
        name: "documents",
        marketplaceName: "openai-primary-runtime",
        version: "26.909.12148",
        installed: true,
        enabled: true,
        source: { source: "local", path: "C:\\x\\plugins\\documents" },
      },
      {
        name: "pdf",
        marketplaceName: "openai-primary-runtime",
        enabled: false,
      },
      { name: "", marketplaceName: "" },
    ],
  });

  it("maps pluginIds, versions, and enabled state", () => {
    expect(parseCodexPluginList(LIST_JSON)).toEqual([
      {
        id: "documents@openai-primary-runtime",
        source: "global",
        kind: "marketplace",
        version: "26.909.12148",
        enabled: true,
      },
      {
        id: "pdf@openai-primary-runtime",
        source: "global",
        kind: "marketplace",
        enabled: false,
      },
    ]);
  });

  it("returns null for unparseable output (caller falls back to config)", () => {
    expect(parseCodexPluginList("not json")).toBeNull();
    expect(parseCodexPluginList('{"installed": "nope"}')).toBeNull();
  });

  it("returns [] for an empty installed list", () => {
    expect(parseCodexPluginList('{"installed": []}')).toEqual([]);
  });
});

describe("readCodexPluginsFile", () => {
  it("reads [plugins.*] tables with enabled flags", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-plugins-file-"));
    try {
      writeConfig(
        join(base, "config.toml"),
        [
          'model = "gpt-5"',
          "",
          "# a comment",
          '[plugins."github@openai-curated"]',
          "enabled = true",
          "",
          "[projects.'c:\\x']",
          'trust_level = "trusted"',
          "",
          '[plugins."vercel@openai-curated"]',
          "enabled = false",
          "",
        ].join("\n"),
      );
      expect(readCodexPluginsFile({ codexHome: base })).toEqual([
        { id: "github@openai-curated", source: "global", kind: "marketplace", enabled: true },
        { id: "vercel@openai-curated", source: "global", kind: "marketplace", enabled: false },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing (not an error)", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-plugins-missing-"));
    try {
      expect(readCodexPluginsFile({ codexHome: base })).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("probeCodexPlugins (hermetic)", () => {
  it("parses canned output through the full spawn path", async () => {
    const canned = JSON.stringify({
      installed: [{ pluginId: "canned@market", version: "1.0", enabled: true }],
    });
    const empty = mkdtempSync(join(tmpdir(), "codex-plugins-canned-"));
    try {
      const res = await probeCodexPlugins(
        process.execPath,
        ["-e", `console.log(${JSON.stringify(canned)})`],
        { codexHome: empty },
      );
      expect(res).toEqual([
        {
          id: "canned@market",
          source: "global",
          kind: "marketplace",
          version: "1.0",
          enabled: true,
        },
      ]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("falls back to config.toml when the CLI probe fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "codex-plugins-fallback-"));
    try {
      writeConfig(join(base, "config.toml"), '[plugins."file@market"]\nenabled = true\n');
      const res = await probeCodexPlugins("definitely-not-a-binary-xyz", [], {
        codexHome: base,
      });
      expect(res).toEqual([
        { id: "file@market", source: "global", kind: "marketplace", enabled: true },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("CodexRuntime.plugins", () => {
  it("lists live plugins when installed (documents@openai-primary-runtime)", async () => {
    const runtime = new CodexRuntime();
    const plugins = await runtime.plugins();
    if (plugins.length === 0) return;
    expect(plugins.map((p) => p.id)).toContain("documents@openai-primary-runtime");
    expect(plugins.every((p) => p.kind === "marketplace")).toBe(true);
  }, 15000);
});

describe("OpencodeRuntime.plugins", () => {
  it("is callable and returns an array (live env may be empty)", async () => {
    const runtime = new OpencodeRuntime();
    const plugins = await runtime.plugins();
    expect(Array.isArray(plugins)).toBe(true);
  });
});

describe("doctor Plugins row", () => {
  it("warns plugins-empty through the stub registry", async () => {
    const base = new OpencodeRuntime();
    const runtime = {
      id: base.id,
      info: () => base.info(),
      detect: () =>
        Promise.resolve({ installed: true, executable: "/usr/bin/opencode", version: "1.18.31" }),
      createSession: (o?: unknown) =>
        base.createSession(o as Parameters<OpencodeRuntime["createSession"]>[0]),
      capabilities: () => base.capabilities(),
      models: () => Promise.resolve([{ id: "m" }]),
      auth: () => Promise.resolve({ authenticated: true, method: "oauth" as const, detail: "ok" }),
      mcp: () => Promise.resolve([]),
      skills: () => Promise.resolve([]),
      plugins: () => Promise.resolve([]),
      installs: () => Promise.resolve([]),
    };
    const report = await doctor("opencode", {
      resolve: () => Promise.resolve(runtime),
    });
    const row = report.checks.find((c) => c.name === "Plugins");
    expect(row?.status).toBe("warn");
    expect(row?.reason).toBe("plugins-empty");
  });
});
