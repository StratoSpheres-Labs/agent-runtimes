import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCodexModelSupport,
  readCodexDefaultModel,
  resolveCodexConfigPath,
} from "../runtimes/codex/definition.js";
import { CodexRuntime } from "../runtimes/codex/runtime.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import type { RuntimeStatus } from "../src/core/runtime.js";

function emptyHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-runtimes-codex-home-"));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeConfig(dir: string, body: string): void {
  writeFileSync(join(dir, "config.toml"), body, "utf-8");
}

describe("resolveCodexConfigPath", () => {
  it("prefers CODEX_HOME, else ~/.codex", () => {
    expect(resolveCodexConfigPath({ CODEX_HOME: "C:\\x" })).toBe(join("C:\\x", "config.toml"));
    expect(resolveCodexConfigPath({})).toBe(join(homedir(), ".codex", "config.toml"));
  });
});

describe("readCodexDefaultModel", () => {
  it("reads root model and provider", () => {
    const { dir, cleanup } = emptyHome();
    try {
      writeConfig(dir, 'model = "gpt-5.6-terra"\nmodel_provider = "openai"\n');
      expect(readCodexDefaultModel({ codexHome: dir })).toEqual({
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        hasOverlay: false,
      });
    } finally {
      cleanup();
    }
  });

  it("flags compatibility overlays", () => {
    const { dir, cleanup } = emptyHome();
    try {
      writeConfig(dir, 'model = "gpt-5.6-terra"\nopenai_base_url = "https://proxy.local/v1"\n');
      expect(readCodexDefaultModel({ codexHome: dir })?.hasOverlay).toBe(true);

      writeConfig(dir, 'model = "gpt-5.6-terra"\n[model_providers.openai]\n');
      expect(readCodexDefaultModel({ codexHome: dir })?.hasOverlay).toBe(true);

      writeConfig(dir, 'model = "gpt-5.6-terra"\nprofile = "work"\n');
      expect(readCodexDefaultModel({ codexHome: dir })?.hasOverlay).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("ignores comments and quoted keys, returns null without a model", () => {
    const { dir, cleanup } = emptyHome();
    try {
      writeConfig(dir, '# model = "ghost"\n"model" = "gpt-5"\n');
      expect(readCodexDefaultModel({ codexHome: dir })?.model).toBe("gpt-5");
      writeConfig(dir, "project_root_markers = []\n");
      expect(readCodexDefaultModel({ codexHome: dir })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null for missing files", () => {
    const { dir, cleanup } = emptyHome();
    try {
      expect(readCodexDefaultModel({ codexHome: dir })).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("checkCodexModelSupport", () => {
  it("fails a proven floor violation with the required version", () => {
    const { dir, cleanup } = emptyHome();
    try {
      const opts = { codexHome: dir };
      expect(checkCodexModelSupport("gpt-5.6-terra", "codex-cli 0.142.0", opts)).toEqual({
        supported: false,
        model: "gpt-5.6-terra",
        required: "0.143.0",
      });
      expect(checkCodexModelSupport("gpt-5.6-terra", "codex-cli 0.150.1", opts)).toEqual({
        supported: true,
      });
    } finally {
      cleanup();
    }
  });

  it("fails open on unknown models, versions, and missing config", () => {
    const { dir, cleanup } = emptyHome();
    try {
      const opts = { codexHome: dir };
      expect(checkCodexModelSupport("gpt-5", "codex-cli 0.142.0", opts)).toEqual({
        supported: true,
      });
      expect(checkCodexModelSupport("gpt-5.6-terra", null, opts)).toEqual({ supported: true });
      expect(checkCodexModelSupport("gpt-5.6-terra", "garbage", opts)).toEqual({ supported: true });
      expect(checkCodexModelSupport(undefined, "codex-cli 0.142.0", opts)).toEqual({
        supported: true,
      });
    } finally {
      cleanup();
    }
  });

  it("judges config-file defaults and yields to overlays/custom providers", () => {
    const { dir, cleanup } = emptyHome();
    try {
      const opts = { codexHome: dir };
      writeConfig(dir, 'model = "gpt-5.6-terra"\n');
      expect(checkCodexModelSupport(undefined, "codex-cli 0.142.0", opts)).toEqual({
        supported: false,
        model: "gpt-5.6-terra",
        required: "0.143.0",
      });
      writeConfig(dir, 'model = "gpt-5.6-terra"\nopenai_base_url = "https://x/v1"\n');
      expect(checkCodexModelSupport(undefined, "codex-cli 0.142.0", opts)).toEqual({
        supported: true,
      });
      writeConfig(dir, 'model = "gpt-5.6-terra"\nmodel_provider = "custom"\n');
      expect(checkCodexModelSupport(undefined, "codex-cli 0.142.0", opts)).toEqual({
        supported: true,
      });
    } finally {
      cleanup();
    }
  });
});

describe("CodexRuntime.createSession model preflight", () => {
  class OldCodexRuntime extends CodexRuntime {
    public override detect(): Promise<RuntimeStatus> {
      return Promise.resolve({
        installed: true,
        executable: "codex-test-binary",
        version: "codex-cli 0.142.0",
      });
    }
  }

  it("fails fast on a proven incompatibility", async () => {
    const { dir, cleanup } = emptyHome();
    vi.stubEnv("CODEX_HOME", dir);
    try {
      const rt = new OldCodexRuntime();
      await expect(rt.createSession({ model: "gpt-5.6-terra" })).rejects.toThrow(
        RuntimeSessionError,
      );
      await expect(rt.createSession({ model: "gpt-5.6-terra" })).rejects.toThrow(/0\.143\.0/);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it("passes through judgement-proof sessions", async () => {
    const { dir, cleanup } = emptyHome();
    vi.stubEnv("CODEX_HOME", dir);
    try {
      const rt = new OldCodexRuntime();
      const sess = await rt.createSession({ model: "gpt-5" });
      expect(sess.id.startsWith("codex_")).toBe(true);
      await sess.close();
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });
});
