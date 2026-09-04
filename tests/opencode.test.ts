import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOpencodeArgs, opencodeDefinition } from "../runtimes/opencode/definition.js";
import { OpencodeParser } from "../runtimes/opencode/parser.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("opencode buildArgs", () => {
  it("minimal args", () => {
    expect(buildOpencodeArgs()).toEqual(["run", "--format", "json"]);
    expect(buildOpencodeArgs({ format: "default" })).toEqual(["run", "--format", "default"]);
  });

  it("includes model/session/variant/agent without leaking raw flags to core", () => {
    const args = buildOpencodeArgs({
      model: "anthropic/claude-sonnet-4",
      sessionId: "sess_123",
      variant: "high",
      agent: "build",
    });
    expect(args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-sonnet-4",
      "--session",
      "sess_123",
      "--variant",
      "high",
      "--agent",
      "build",
    ]);
  });

  it("reasoning.effort maps to --variant", () => {
    expect(buildOpencodeArgs({ reasoning: { effort: "high" } })).toEqual([
      "run",
      "--format",
      "json",
      "--variant",
      "high",
    ]);
  });

  it("explicit variant wins over reasoning (single --variant)", () => {
    expect(buildOpencodeArgs({ variant: "max", reasoning: { effort: "low" } })).toEqual([
      "run",
      "--format",
      "json",
      "--variant",
      "max",
    ]);
  });

  it("definition is stdin + stdio + streaming", () => {
    expect(opencodeDefinition.input.type).toBe("stdin");
    expect(opencodeDefinition.transport.type).toBe("stdio");
    expect(opencodeDefinition.capabilities.streaming).toBe(true);
  });

  it("dir maps to --dir (daemon appendOpenCodeWorkspaceDir)", () => {
    expect(buildOpencodeArgs({ dir: "/tmp/proj" })).toContain("--dir");
    expect(buildOpencodeArgs({ dir: "/tmp/proj" })).toContain("/tmp/proj");
  });
});

describe("OpencodeParser fixtures", () => {
  const fixtures = [
    "text.jsonl",
    "tool.jsonl",
    "error.jsonl",
    "done.jsonl",
    "mixed.jsonl",
    "illegal.jsonl",
    "unknown.jsonl",
    "empty.jsonl",
    "real-opencode.jsonl",
    "tool_use.jsonl",
  ] as const;

  for (const name of fixtures) {
    it(`parses ${name} → RuntimeEvent`, () => {
      const raw = readFileSync(`runtimes/opencode/fixtures/${name}`, "utf-8");
      const parser = new OpencodeParser();
      // Simulate real chunk splitting: feed in two halves to test buffering
      const mid = Math.floor(raw.length / 2);
      const a = parser.parse(enc(raw.slice(0, mid)));
      const b = parser.parse(enc(raw.slice(mid)));
      const flushed = parser.flush();
      const all = [...a, ...b, ...flushed];
      for (const e of all) {
        expect([
          "text_delta",
          "tool_started",
          "tool_finished",
          "error",
          "done",
          "session_started",
        ]).toContain(e.type);
      }
      // Empty fixture should yield 0 events
      if (name === "empty.jsonl") {
        expect(all.length).toBe(0);
      } else {
        expect(all.length).toBeGreaterThan(0);
      }
    });
  }

  it("handles opencode tool alias across chunk boundary", () => {
    const p = new OpencodeParser();
    const a = p.parse(enc('{"type":"tool","id":"t1","name":"b'));
    expect(a).toEqual([]);
    const b = p.parse(enc('ash"}\n'));
    expect(b[0]).toMatchObject({ type: "tool_started", id: "t1" });
  });

  it("maps text → text_delta", () => {
    const p = new OpencodeParser();
    const evs = p.parse(enc('{"type":"text","text":"hi"}\n'));
    expect(evs).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  it("maps real opencode part.text shape", () => {
    const p = new OpencodeParser();
    const line = `{"type":"text","part":{"type":"text","text":"Hello from opencode"}}\n`;
    const evs = p.parse(enc(line));
    expect(evs).toEqual([{ type: "text_delta", text: "Hello from opencode" }]);
  });

  it("maps step_start → session_started; step_finish is not terminal", () => {
    const p = new OpencodeParser();
    const s = p.parse(enc('{"type":"step_start","sessionID":"ses_123"}\n'));
    expect(s).toEqual([{ type: "session_started", sessionId: "ses_123" }]);
    // A run emits step_finish per step; only process exit ends the run
    // (DefaultRun synthesizes `done`). Mapping it to `done` would end
    // multi-step runs after their first step.
    expect(p.parse(enc('{"type":"step_finish"}\n'))).toEqual([]);
  });

  it("maps tool_use → tool_started with callID/name/input", () => {
    const p = new OpencodeParser();
    const line =
      `{"type":"tool_use","timestamp":1,"sessionID":"ses_1",` +
      `"part":{"type":"tool","tool":"read","callID":"call_abc",` +
      `"state":{"status":"completed","input":{"filePath":"a.txt"}}}}\n`;
    expect(p.parse(enc(line))).toEqual([
      { type: "tool_started", id: "call_abc", name: "read", input: { filePath: "a.txt" } },
    ]);
  });

  it("recovers session_started when step_start splits across chunks", () => {
    const p = new OpencodeParser();
    const line = `{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"type":"step-start"}}\n`;
    const mid = Math.floor(line.length / 2);
    const a = p.parse(enc(line.slice(0, mid)));
    const b = p.parse(enc(line.slice(mid)));
    expect([...a, ...b, ...p.flush()]).toEqual([{ type: "session_started", sessionId: "ses_abc" }]);
  });

  it("surfaces nested API error messages", () => {
    const p = new OpencodeParser();
    const line =
      `{"type":"error","error":{"name":"APIError",` +
      `"data":{"message":"credit insufficient balance: balance=0"}}}\n`;
    const [first] = p.parse(enc(line));
    expect(first?.type).toBe("error");
    if (first?.type === "error") {
      expect(first.error.message).toContain("credit insufficient");
    }
  });

  it("emits no terminal done mid-stream across a multi-step run", () => {
    const p = new OpencodeParser();
    const lines = [
      `{"type":"step_start","sessionID":"ses_m"}\n`,
      `{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c1","state":{"input":{}}}}\n`,
      `{"type":"step_finish"}\n`,
      `{"type":"text","part":{"type":"text","text":"halfway"}}\n`,
      `{"type":"step_finish"}\n`,
    ].join("");
    const evs = [...p.parse(enc(lines)), ...p.flush()];
    expect(evs.some((e) => e.type === "done")).toBe(false);
    expect(evs.map((e) => e.type)).toEqual(["session_started", "tool_started", "text_delta"]);
  });
});
