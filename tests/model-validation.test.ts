import { describe, expect, it, vi } from "vitest";
import {
  assertKnownModel,
  clearLiveModels,
  isKnownModel,
  rememberLiveModels,
} from "../src/discovery/models.js";
import type { RuntimeModel } from "../src/definition/model.js";
import { RuntimeSessionError } from "../src/core/errors.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";

const AID = "test-agent-xyz";

function live(): RuntimeModel[] {
  return [
    { id: "a/one", provider: "a", name: "one" },
    { id: "b/two", provider: "b", name: "two" },
  ];
}

describe("isKnownModel", () => {
  it("fails open when nothing was ever surfaced", () => {
    clearLiveModels(AID);
    expect(isKnownModel(AID, "anything/at-all")).toBe(true);
  });

  it("matches remembered ids and fallback ids, exactly", () => {
    try {
      rememberLiveModels(AID, live());
      expect(isKnownModel(AID, "a/one")).toBe(true);
      expect(isKnownModel(AID, "A/ONE")).toBe(false);
      expect(isKnownModel(AID, "zzz", [{ id: "zzz" }])).toBe(true);
      expect(isKnownModel(AID, "zzz")).toBe(false);
    } finally {
      clearLiveModels(AID);
    }
  });

  it("does not let empty lists wipe the cache", () => {
    try {
      rememberLiveModels(AID, live());
      rememberLiveModels(AID, []);
      expect(isKnownModel(AID, "a/one")).toBe(true);
    } finally {
      clearLiveModels(AID);
    }
  });

  it("clear restores fail-open", () => {
    rememberLiveModels(AID, live());
    clearLiveModels(AID);
    expect(isKnownModel(AID, "nope")).toBe(true);
  });
});

describe("assertKnownModel", () => {
  it("passes undefined models without probing", async () => {
    const refresh = vi.fn(() => Promise.resolve(live()));
    await assertKnownModel(AID, undefined, [], refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("passes known models without probing", async () => {
    clearLiveModels(AID);
    try {
      rememberLiveModels(AID, live());
      const refresh = vi.fn(() => Promise.resolve(live()));
      await assertKnownModel(AID, "a/one", [], refresh);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      clearLiveModels(AID);
    }
  });

  it("passes unprimed unknowns without probing (fail open)", async () => {
    clearLiveModels(AID);
    const refresh = vi.fn(() => Promise.resolve(live()));
    await assertKnownModel(AID, "never-seen", [], refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-probes once on a primed miss, then decides", async () => {
    clearLiveModels(AID);
    try {
      rememberLiveModels(AID, live());
      // Brand-new model appears on refresh → pass.
      const fresh = vi.fn(() => Promise.resolve([...live(), { id: "c/three" }]));
      await assertKnownModel(AID, "c/three", [], fresh);
      expect(fresh).toHaveBeenCalledTimes(1);
      // Still unknown afterwards → throw the unknown-model error.
      const stale = vi.fn(() => Promise.resolve(live()));
      await expect(assertKnownModel(AID, "ghost", [], stale)).rejects.toThrow(RuntimeSessionError);
      await expect(assertKnownModel(AID, "ghost", [], stale)).rejects.toThrow(/unknown model/);
      // Refresh itself failing keeps the original unknown-model error.
      const broken = vi.fn(() => Promise.reject(new Error("network down")));
      await expect(assertKnownModel(AID, "ghost", [], broken)).rejects.toThrow(/unknown model/);
    } finally {
      clearLiveModels(AID);
    }
  });
});

describe("createSession model gate (hermetic-ish)", () => {
  // Primed miss triggers one real refresh probe (opencode catalog, ~15s
  // worst case) before rejecting — generous timeout, still no model turn.
  // Single attempt: a second call would pay the full probe twice.
  it("rejects unknown models before anything spawns", async () => {
    rememberLiveModels("opencode", [{ id: "a/b" }]);
    try {
      const rt = new OpencodeRuntime();
      const err = await rt.createSession({ model: "definitely-not-a-model" }).then(
        (): unknown => {
          throw new Error("should have thrown");
        },
        (e: unknown): unknown => e,
      );
      expect(err).toBeInstanceOf(RuntimeSessionError);
      expect(err instanceof Error && err.message).toContain("unknown model");
    } finally {
      clearLiveModels("opencode");
    }
  }, 30000);
});
