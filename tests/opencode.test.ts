import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildOpencodeArgs,
  isOpencodeV2,
  opencodeDefinition,
} from "../runtimes/opencode/definition.js";
import { OpencodeParser } from "../runtimes/opencode/parser.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("opencode buildArgs", () => {
  it("minimal args", () => {
    expect(buildOpencodeArgs()).toEqual(["run", "--format", "json", "--thinking"]);
    expect(buildOpencodeArgs({ format: "default" })).toEqual(["run", "--format", "default"]);
  });

  it("omits --thinking for human-readable format (display untouched)", () => {
    expect(buildOpencodeArgs({ format: "default" })).not.toContain("--thinking");
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
      "--thinking",
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
      "--thinking",
      "--variant",
      "high",
    ]);
  });

  it("explicit variant wins over reasoning (single --variant)", () => {
    expect(buildOpencodeArgs({ variant: "max", reasoning: { effort: "low" } })).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
      "--variant",
      "max",
    ]);
  });

  it("isOpencodeV2 branches on major version, fails open on garbage", () => {
    expect(isOpencodeV2(undefined)).toBe(false);
    expect(isOpencodeV2("")).toBe(false);
    expect(isOpencodeV2("not-a-version")).toBe(false);
    expect(isOpencodeV2("1.18.32")).toBe(false);
    expect(isOpencodeV2("opencode v2.0.18")).toBe(true);
    expect(isOpencodeV2("2.0.18")).toBe(true);
  });

  it("v2 drops --dir (Unrecognized flag, verified live 2.0.18)", () => {
    expect(buildOpencodeArgs({ dir: "D:\\proj", cliVersion: "opencode v2.0.18" })).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
    ]);
    // 1.x keeps it (byte-identical legacy).
    expect(buildOpencodeArgs({ dir: "D:\\proj", cliVersion: "1.18.32" })).toContain("--dir");
    expect(buildOpencodeArgs({ dir: "D:\\proj" })).toContain("--dir");
  });

  it("v2 inlines variant as --model id#variant, never --variant", () => {
    // Explicit knownModels keeps the gate deterministic regardless of the
    // module cache state left by other test files.
    const known = [{ id: "opencode/mimo-v2.6-flash-free", reasoningOptions: [{ id: "high" }] }];
    expect(
      buildOpencodeArgs({
        model: "opencode/mimo-v2.6-flash-free",
        variant: "high",
        knownModels: known,
        cliVersion: "2.0.18",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
      "--model",
      "opencode/mimo-v2.6-flash-free#high",
    ]);
  });

  it("v2 omits a variant with no model (nothing to inline into)", () => {
    expect(buildOpencodeArgs({ variant: "high", cliVersion: "2.0.18" })).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
    ]);
  });

  it("v2 omits variant without catalog evidence (strict gate, live 2.0.18)", () => {
    // A never-fetched catalog must not legacy-emit: `#low` for a model
    // without it hard-fails the turn (`Variant unavailable`, verified
    // live) — omit and run the base model instead.
    expect(
      buildOpencodeArgs({
        model: "opencode/mimo-v2.6-flash-free",
        variant: "low",
        knownModels: [],
        cliVersion: "2.0.18",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
      "--model",
      "opencode/mimo-v2.6-flash-free",
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
    "tool-completed.jsonl",
    "permission-denied.jsonl",
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
          "reasoning_delta",
          "tool_started",
          "tool_finished",
          "error",
          "done",
          "session_started",
          "permission_denied",
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

  it("permission-denied parses identically under CRLF line endings (checklist: \\r\\n variant)", () => {
    const raw = readFileSync("runtimes/opencode/fixtures/permission-denied.jsonl", "utf-8");
    const lf = [...new OpencodeParser().parse(enc(raw)), ...new OpencodeParser().flush()];
    const crlfRaw = raw.replaceAll("\n", "\r\n");
    const crlf = [...new OpencodeParser().parse(enc(crlfRaw)), ...new OpencodeParser().flush()];
    expect(crlf).toEqual(lf);
    expect(lf.length).toBeGreaterThan(0);
  });

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

  it("maps reasoning part → reasoning_delta (live 1.18.31 shape, ids anonymized)", () => {
    // Verified live: `opencode run --format json --thinking` emits
    // {"type":"reasoning",...,"part":{"type":"reasoning","text":"..."}}.
    const p = new OpencodeParser();
    const line = JSON.stringify({
      type: "reasoning",
      timestamp: 1789641894041,
      sessionID: "ses_test",
      part: {
        id: "prt_test",
        messageID: "msg_test",
        sessionID: "ses_test",
        type: "reasoning",
        text: "Let me compute 17 times 23.",
        time: { start: 1789641894023, end: 1789641894031 },
      },
    });
    expect(p.parse(enc(line + "\n"))).toEqual([
      { type: "reasoning_delta", text: "Let me compute 17 times 23." },
    ]);
  });

  it("drops empty-text reasoning without error (encrypted-only, verified live)", () => {
    // GPT-family models return encrypted reasoning with text:"" — a valid
    // envelope with nothing displayable.
    const p = new OpencodeParser();
    const line = JSON.stringify({
      type: "reasoning",
      sessionID: "ses_test",
      part: { id: "prt_test", type: "reasoning", text: "" },
    });
    expect(p.parse(enc(line + "\n"))).toEqual([]);
    expect(p.flush()).toEqual([]);
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

  it("maps pending tool_use → tool_started with callID/name/input", () => {
    const p = new OpencodeParser();
    const line =
      `{"type":"tool_use","timestamp":1,"sessionID":"ses_1",` +
      `"part":{"type":"tool","tool":"read","callID":"call_abc",` +
      `"state":{"status":"pending","input":{"filePath":"a.txt"}}}}\n`;
    expect(p.parse(enc(line))).toEqual([
      { type: "tool_started", id: "call_abc", name: "read", input: { filePath: "a.txt" } },
    ]);
  });

  it("maps a single completed tool_use → tool_started + tool_finished (paired id)", () => {
    // Fast tools arrive as ONE line carrying input and output together.
    const p = new OpencodeParser();
    const line =
      `{"type":"tool_use","timestamp":1,"sessionID":"ses_1",` +
      `"part":{"type":"tool","tool":"bash","callID":"call_xyz",` +
      `"state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\r\\n",` +
      `"metadata":{"output":"hi\\r\\n","exit":0,"truncated":false}}}}\n`;
    expect(p.parse(enc(line))).toEqual([
      {
        type: "tool_started",
        id: "call_xyz",
        name: "bash",
        input: { command: "echo hi" },
      },
      { type: "tool_finished", id: "call_xyz", output: "hi\r\n", error: false },
    ]);
  });

  it("pending then completed emits exactly one start and one finish", () => {
    const p = new OpencodeParser();
    const pending =
      `{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c9",` +
      `"state":{"status":"running","input":{}}}}\n`;
    const completed =
      `{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c9",` +
      `"state":{"status":"completed","input":{},"output":"ok"}}}\n`;
    const evs = [...p.parse(enc(pending)), ...p.parse(enc(completed))];
    expect(evs.map((e) => e.type)).toEqual(["tool_started", "tool_finished"]);
    expect(evs[0]).toMatchObject({ id: "c9" });
    expect(evs[1]).toMatchObject({ id: "c9", output: "ok", error: false });
  });

  it("marks tool_finished error on error status or nonzero exit", () => {
    const p = new OpencodeParser();
    const line =
      `{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"ce",` +
      `"state":{"status":"error","input":{},"output":"boom"}}}\n`;
    const evs = p.parse(enc(line));
    expect(evs[evs.length - 1]).toMatchObject({ type: "tool_finished", id: "ce", error: true });
  });

  it("pairs start/finish across the live tool-completed fixture", () => {
    const raw = readFileSync("runtimes/opencode/fixtures/tool-completed.jsonl", "utf-8");
    const p = new OpencodeParser();
    const evs = [...p.parse(enc(raw)), ...p.flush()];
    expect(evs.map((e) => e.type)).toEqual([
      "session_started",
      "text_delta",
      "tool_started",
      "tool_finished",
      "session_started",
      "text_delta",
    ]);
    const started = evs[2];
    const finished = evs[3];
    expect(started).toMatchObject({ type: "tool_started", name: "bash" });
    expect(finished).toMatchObject({ type: "tool_finished", error: false });
    if (started?.type === "tool_started" && finished?.type === "tool_finished") {
      expect(finished.id).toBe(started.id);
      expect(JSON.stringify(finished.output)).toContain("hello-tool");
    }
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

  it("maps headless-reject refusals to permission_denied (live 1.18.32)", () => {
    const p = new OpencodeParser();
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        callID: "call_deny1",
        state: {
          status: "error",
          input: { filePath: "note.txt" },
          error: "The user rejected permission to use this specific tool call.",
        },
      },
    });
    const evs = p.parse(enc(line + "\n"));
    expect(evs.map((e) => e.type)).toEqual(["tool_started", "tool_finished", "permission_denied"]);
    const denied = evs[2];
    expect(denied).toMatchObject({
      type: "permission_denied",
      id: "call_deny1",
      toolName: "edit",
      reason: "The user rejected permission to use this specific tool call.",
      kind: "reject",
    });
  });

  it("strips the ruleset JSON off deny-rule refusals, keeps kind=deny", () => {
    const p = new OpencodeParser();
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_deny2",
        state: {
          status: "error",
          error:
            'The user has specified a rule which prevents you from using this specific tool call. Rules: [{"tool":"bash","action":"deny"}]',
        },
      },
    });
    const denied = p.parse(enc(line + "\n")).find((e) => e.type === "permission_denied");
    expect(denied).toMatchObject({
      id: "call_deny2",
      toolName: "bash",
      reason:
        "The user has specified a rule which prevents you from using this specific tool call.",
      kind: "deny",
    });
  });

  it("ordinary tool errors never become permission_denied", () => {
    const p = new OpencodeParser();
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_err",
        state: { status: "error", error: "exit code 1: boom" },
      },
    });
    const evs = p.parse(enc(line + "\n"));
    expect(evs.map((e) => e.type)).toEqual(["tool_started", "tool_finished"]);
    expect(evs[evs.length - 1]).toMatchObject({ type: "tool_finished", error: true });
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
