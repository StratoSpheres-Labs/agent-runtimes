import { describe, expect, it } from "vitest";
import type { RuntimeCapabilities } from "../src/definition/capability.js";
import type { SessionInputRequest } from "../src/definition/session-inputs.js";
import {
  MAX_OUTPUT_SCHEMA_BYTES,
  assertSessionInputsSupported,
  assertWorkspaceFieldsSupported,
  normalizeOutputSchema,
  sanitizeConfigId,
  sanitizeResumeId,
  sanitizeToolName,
} from "../src/definition/session-inputs.js";
import { hasWorkspaceFields } from "../src/definition/workspace.js";
import { RuntimeSessionError } from "../src/core/errors.js";

const FULL: RuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  modelSelection: true,
  reasoning: true,
  images: true,
  workspace: true,
  agentSelection: true,
  midRunInput: true,
  historySeed: true,
  systemPrompt: true,
  maxTokens: true,
  costBudget: true,
  structuredOutput: true,
  toolAllowlist: true,
  profileSelection: true,
};

const NONE: RuntimeCapabilities = {
  ...FULL,
  agentSelection: false,
  midRunInput: false,
  historySeed: false,
  systemPrompt: false,
  maxTokens: false,
  costBudget: false,
  structuredOutput: false,
  toolAllowlist: false,
  profileSelection: false,
  reasoning: false,
};

describe("assertSessionInputsSupported", () => {
  it("passes empty options against any capabilities", () => {
    expect(() => {
      assertSessionInputsSupported("x", NONE, {});
    }).not.toThrow();
    expect(() => {
      assertSessionInputsSupported("x", NONE, {
        agent: "  ",
        allowedTools: [],
        seedMessages: [],
      });
    }).not.toThrow();
  });

  it("passes everything when all capabilities are true", () => {
    expect(() => {
      assertSessionInputsSupported("x", FULL, {
        agent: "build",
        systemPrompt: "be nice",
        maxTokens: 100,
        maxBudgetUsd: 2.5,
        profile: "fast",
        allowedTools: ["Read"],
        seedMessages: [{ role: "user", text: "hi" }],
        reasoning: { effort: "low" },
      });
    }).not.toThrow();
  });

  it("rejects each unsupported input loudly", () => {
    const cases: Array<[SessionInputRequest, RegExp]> = [
      [{ agent: "build" }, /agent selection/],
      [{ profile: "fast" }, /config profiles/],
      [{ systemPrompt: "be nice" }, /system prompts/],
      [{ maxTokens: 100 }, /token budgets/],
      [{ maxBudgetUsd: 2.5 }, /cost budgets/],
      [{ allowedTools: ["Read"] }, /tool allowlists/],
      [{ seedMessages: [{ role: "user", text: "hi" }] }, /history seeding/],
      [{ reasoning: { effort: "low" } }, /reasoning controls/],
    ];
    for (const [opts, pattern] of cases) {
      expect(() => {
        assertSessionInputsSupported("opencode", NONE, opts);
      }).toThrow(pattern);
      expect(() => {
        assertSessionInputsSupported("opencode", NONE, opts);
      }).toThrow(RuntimeSessionError);
    }
  });

  it("rejects malformed maxTokens regardless of capability", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(() => {
        assertSessionInputsSupported("x", FULL, { maxTokens: bad });
      }).toThrow(/positive integer/);
    }
  });

  it("rejects malformed maxBudgetUsd regardless of capability", () => {
    for (const bad of [0, -2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        assertSessionInputsSupported("x", FULL, { maxBudgetUsd: bad });
      }).toThrow(/positive dollar amount/);
    }
    expect(() => {
      assertSessionInputsSupported("x", FULL, {
        maxBudgetUsd: "5" as unknown as number,
      });
    }).toThrow(/positive dollar amount/);
  });

  it("rejects malformed seedMessages regardless of capability", () => {
    expect(() => {
      assertSessionInputsSupported("x", FULL, {
        seedMessages: [{ role: "user", text: "" }],
      });
    }).toThrow(/invalid seedMessages/);
    expect(() => {
      assertSessionInputsSupported("x", FULL, {
        seedMessages: [{ role: "system", text: "hi" } as unknown as { role: "user"; text: string }],
      });
    }).toThrow(/invalid seedMessages/);
  });
});

describe("assertWorkspaceFieldsSupported", () => {
  it("passes empty workspace against an empty allowlist", () => {
    expect(() => {
      assertWorkspaceFieldsSupported("opencode", [], undefined);
    }).not.toThrow();
    expect(() => {
      assertWorkspaceFieldsSupported("opencode", [], {});
    }).not.toThrow();
  });

  it("rejects unwired sub-fields, naming them", () => {
    expect(() => {
      assertWorkspaceFieldsSupported("opencode", [], { allowedPaths: ["/a"] });
    }).toThrow(/allowedPaths/);
    expect(() => {
      assertWorkspaceFieldsSupported("claude", ["allowedPaths"], { sandboxMode: "x" });
    }).toThrow(/sandboxMode/);
    expect(() => {
      assertWorkspaceFieldsSupported("codex", ["allowedPaths"], { permissionMode: "plan" });
    }).toThrow(/permissionMode/);
  });

  it("detects the autoReview field", () => {
    expect(hasWorkspaceFields({ autoReview: true })).toBe(true);
    expect(hasWorkspaceFields({ autoReview: false })).toBe(false);
    expect(() => {
      assertWorkspaceFieldsSupported("codex", ["allowedPaths", "autoReview"], {
        autoReview: true,
      });
    }).not.toThrow();
    expect(() => {
      assertWorkspaceFieldsSupported("claude", ["allowedPaths"], { autoReview: true });
    }).toThrow(/autoReview/);
  });

  it("passes wired subsets", () => {
    expect(() => {
      assertWorkspaceFieldsSupported(
        "claude",
        ["allowedPaths", "permissionMode", "dangerouslySkipPermissions"],
        { allowedPaths: ["/a"], permissionMode: "plan" },
      );
    }).not.toThrow();
    expect(() => {
      assertWorkspaceFieldsSupported(
        "codex",
        ["allowedPaths", "sandboxMode", "dangerouslySkipPermissions"],
        { sandboxMode: "read-only", dangerouslySkipPermissions: true },
      );
    }).not.toThrow();
  });
});

describe("hasWorkspaceFields", () => {
  it("detects each field", () => {
    expect(hasWorkspaceFields(undefined)).toBe(false);
    expect(hasWorkspaceFields({})).toBe(false);
    expect(hasWorkspaceFields({ allowedPaths: [] })).toBe(false);
    expect(hasWorkspaceFields({ allowedPaths: ["/a"] })).toBe(true);
    expect(hasWorkspaceFields({ permissionMode: "plan" })).toBe(true);
    expect(hasWorkspaceFields({ dangerouslySkipPermissions: true })).toBe(true);
    expect(hasWorkspaceFields({ sandboxMode: "x" })).toBe(true);
  });
});

describe("normalizeOutputSchema", () => {
  it("accepts objects and JSON strings, drops blanks", () => {
    expect(normalizeOutputSchema({ type: "object" }, "x")).toBe('{"type":"object"}');
    expect(normalizeOutputSchema('{"type":"object"}', "x")).toBe('{"type":"object"}');
    expect(normalizeOutputSchema(undefined, "x")).toBeUndefined();
    expect(normalizeOutputSchema("  ", "x")).toBeUndefined();
  });

  it("rejects non-objects, garbage and non-JSON values", () => {
    for (const bad of ["{oops", "[1,2]", "42", "null"]) {
      expect(() => {
        normalizeOutputSchema(bad, "x");
      }).toThrow(/outputSchema/);
    }
    expect(() => {
      normalizeOutputSchema({ fn: () => 1 }, "x");
    }).toThrow(/plain JSON/);
    expect(() => {
      normalizeOutputSchema({ big: "x".repeat(MAX_OUTPUT_SCHEMA_BYTES) }, "x");
    }).toThrow(/budget/);
  });

  it("gates on the structuredOutput capability", () => {
    expect(() => {
      assertSessionInputsSupported("x", FULL, { outputSchema: { type: "object" } });
    }).not.toThrow();
    expect(() => {
      assertSessionInputsSupported("x", NONE, { outputSchema: { type: "object" } });
    }).toThrow(/structured output/);
  });
});

describe("sanitizers", () => {
  it("sanitizeConfigId trims, drops blanks, rejects flag shapes", () => {
    expect(sanitizeConfigId(undefined, "agent", "x")).toBeUndefined();
    expect(sanitizeConfigId("  ", "agent", "x")).toBeUndefined();
    expect(sanitizeConfigId(" build ", "agent", "x")).toBe("build");
    expect(sanitizeConfigId("fast", "profile", "codex")).toBe("fast");
    expect(() => sanitizeConfigId("--evil", "agent", "x")).toThrow(/invalid agent id/);
    expect(() => sanitizeConfigId("a/b", "profile", "codex")).toThrow(/invalid profile id/);
  });

  it("sanitizeToolName accepts ids and scopes, rejects empties and flags", () => {
    expect(sanitizeToolName("Read", "claude")).toBe("Read");
    expect(sanitizeToolName("mcp__github__*", "claude")).toBe("mcp__github__*");
    expect(() => sanitizeToolName("", "claude")).toThrow(/invalid allowedTools/);
    expect(() => sanitizeToolName("--allowedTools", "claude")).toThrow(/invalid allowedTools/);
    expect(() => sanitizeToolName("rm -rf", "claude")).toThrow(/invalid allowedTools/);
  });

  it("sanitizeResumeId fits uuid/ses/thread ids, rejects flag shapes", () => {
    expect(sanitizeResumeId(undefined, "x")).toBeUndefined();
    expect(sanitizeResumeId("  ", "x")).toBeUndefined();
    expect(sanitizeResumeId("6fd6faeb-a5da-48c2-ab2d-7691045af24b", "claude")).toBe(
      "6fd6faeb-a5da-48c2-ab2d-7691045af24b",
    );
    expect(sanitizeResumeId("ses_abc123", "opencode")).toBe("ses_abc123");
    expect(() => sanitizeResumeId("--dangerously-skip-permissions", "x")).toThrow(
      /resumeSessionId/,
    );
    expect(() => sanitizeResumeId("a b", "x")).toThrow(/resumeSessionId/);
    expect(() => sanitizeResumeId("../../x", "x")).toThrow(/resumeSessionId/);
  });

  it("sanitizeConfigId covers mcpServer names (no spaces/wildcards)", () => {
    expect(sanitizeConfigId("github", "mcpServer", "claude")).toBe("github");
    expect(() => sanitizeConfigId("evil name", "mcpServer", "claude")).toThrow(
      /invalid mcpServer id/,
    );
    expect(() => sanitizeConfigId("a*b", "mcpServer", "claude")).toThrow(/invalid mcpServer id/);
  });
});
