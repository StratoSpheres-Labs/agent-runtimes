import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildClaudeArgs,
  buildClaudeStdinPrompt,
  claudeDefinition,
} from "../runtimes/claude/definition.js";
import { ClaudeParser } from "../runtimes/claude/parser.js";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("claude buildArgs", () => {
  it("minimal args", () => {
    expect(buildClaudeArgs()).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("includes model/session/permission without leaking to core", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      sessionId: "s1",
      permissionMode: "bypassPermissions",
    });
    expect(args).toContain("--model");
    expect(args).toContain("--session-id");
    expect(args).toContain("--permission-mode");
  });

  it("dangerouslySkipPermissions adds its own flag (open-design bypass alias)", () => {
    expect(buildClaudeArgs({ dangerouslySkipPermissions: true })).toContain(
      "--dangerously-skip-permissions",
    );
    expect(buildClaudeArgs({})).not.toContain("--dangerously-skip-permissions");
    const both = buildClaudeArgs({ permissionMode: "bypassPermissions", dangerouslySkipPermissions: true });
    expect(both).toContain("--permission-mode");
    expect(both).toContain("--dangerously-skip-permissions");
  });

  it("prefers resume over session-id", () => {
    const args = buildClaudeArgs({ resumeId: "r1", sessionId: "s1" });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  it("reasoning.effort maps to --effort", () => {
    // Verified against `claude --help` on 2.1.112:
    // `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)`.
    expect(buildClaudeArgs({ reasoning: { effort: "high" } })).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--effort",
      "high",
    ]);
  });

  it("definition is stdin + stdio + streaming", () => {
    expect(claudeDefinition.input.type).toBe("stdin");
    expect(claudeDefinition.transport.type).toBe("stdio");
    expect(claudeDefinition.capabilities.streaming).toBe(true);
  });
});

describe("ClaudeParser fixtures", () => {
  const fixtures = ["text.jsonl", "tool.jsonl", "mixed.jsonl", "user-tool-result.jsonl"] as const;
  for (const name of fixtures) {
    it(`parses ${name} → RuntimeEvent`, () => {
      const raw = readFileSync(`runtimes/claude/fixtures/${name}`, "utf-8");
      const p = new ClaudeParser();
      const mid = Math.floor(raw.length / 2);
      const a = p.parse(enc(raw.slice(0, mid)));
      const b = p.parse(enc(raw.slice(mid)));
      const flushed = p.flush();
      const all = [...a, ...b, ...flushed];
      for (const e of all) {
        expect([
          "text_delta",
          "tool_started",
          "tool_finished",
          "error",
          "done",
          "session_started",
          "permission_request",
          "usage",
        ]).toContain(e.type);
      }
      expect(all.length).toBeGreaterThan(0);
    });
  }

  it("assistant text → text_delta", () => {
    const p = new ClaudeParser();
    const line = `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n`;
    const evs = p.parse(enc(line));
    expect(evs.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("tool_use → tool_started and tool_result → tool_finished", () => {
    const p = new ClaudeParser();
    const a = p.parse(
      enc(
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"id1","name":"Bash","input":{"cmd":"ls"}}]}}\n`,
      ),
    );
    expect(a[0]).toMatchObject({ type: "tool_started", id: "id1" });
    const b = p.parse(enc(`{"type":"tool_result","tool_use_id":"id1","content":"ok"}\n`));
    expect(b[0]).toMatchObject({ type: "tool_finished", id: "id1" });
  });

  it("result → done", () => {
    const p = new ClaudeParser();
    const evs = p.parse(enc(`{"type":"result","subtype":"success"}\n`));
    expect(evs[0]?.type).toBe("done");
  });

  it("user envelope tool_result → tool_finished (print-mode shape)", () => {
    // Verified live on 2.1.187: print mode delivers tool results inside a
    // `user` transcript envelope, not as top-level `tool_result`.
    const p = new ClaudeParser();
    const line =
      `{"type":"user","message":{"role":"user","content":` +
      `[{"type":"tool_result","tool_use_id":"id9","content":"P:ECHO:MCP42"}]}}\n`;
    expect(p.parse(enc(line))).toEqual([
      { type: "tool_finished", id: "id9", output: "P:ECHO:MCP42" },
    ]);
  });

  it("user envelope without tool_result is ignored, not errored", () => {
    const p = new ClaudeParser();
    const line = `{"type":"user","message":{"role":"user","content":"hi"}}\n`;
    expect(p.parse(enc(line))).toEqual([]);
  });

  it("maps system/init session_id → session_started; other envelopes ignored", () => {
    const p = new ClaudeParser();
    const lines =
      `{"type":"system","subtype":"init","session_id":"ses_init_1"}\n` +
      `{"type":"system","subtype":"hook_started","hook_name":"x"}\n`;
    const mid = Math.floor(lines.length / 2);
    const a = p.parse(enc(lines.slice(0, mid)));
    const b = p.parse(enc(lines.slice(mid)));
    expect([...a, ...b, ...p.flush()]).toEqual([
      { type: "session_started", sessionId: "ses_init_1" },
    ]);
  });

  it("AskUserQuestion → permission_request (interactive mode)", () => {
    const p = new ClaudeParser();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "q1",
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: "Allow edit?", options: [{ label: "Yes", kind: "allow_once" }, { label: "No", kind: "reject_once" }] },
              ],
            },
          },
        ],
      },
    });
    const evs = p.parse(enc(line + "\n"));
    expect(evs[0]).toMatchObject({ type: "permission_request", id: "q1", toolName: "AskUserQuestion" });
    expect((evs[0] as { options: Array<{ optionId: string }> }).options.map((o) => o.optionId)).toEqual(["Yes", "No"]);
  });

  it("AskUserQuestion without questions still yields permission_request with default option", () => {
    const p = new ClaudeParser();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: {} }] },
    });
    expect(p.parse(enc(line + "\n"))[0]).toMatchObject({ type: "permission_request", id: "q2" });
  });
});

describe("claude stdin prompt", () => {
  it("builds the stream-json user message (argv carries no prompt)", () => {
    // Wire format verified live against Claude Code 2.1.187: with
    // --input-format stream-json the positional prompt is ignored and an
    // immediately-closed stdin ends the turn empty.
    expect(buildClaudeStdinPrompt("hi")).toBe(
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n",
    );
  });
});
