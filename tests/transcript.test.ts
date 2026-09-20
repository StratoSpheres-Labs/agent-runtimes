import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectHistory,
  toMs,
  truncateTranscriptText,
  type TranscriptEntry,
} from "../src/definition/transcript.js";
import { parseCodexRollout, readCodexTranscript } from "../runtimes/codex/transcript.js";
import { parseClaudeTranscript, readClaudeTranscript } from "../runtimes/claude/transcript.js";
import { readOpencodeTranscript } from "../runtimes/opencode/transcript.js";

describe("transcript helpers", () => {
  it("toMs normalizes seconds and milliseconds, rejects the rest", () => {
    expect(toMs(1789641894074)).toBe(1789641894074);
    expect(toMs(1789641894)).toBe(1789641894000);
    expect(toMs("x")).toBeUndefined();
    expect(toMs(Number.NaN)).toBeUndefined();
    expect(toMs(42)).toBeUndefined();
  });

  it("truncateTranscriptText caps with an ellipsis", () => {
    expect(truncateTranscriptText("abc", 10)).toBe("abc");
    expect(truncateTranscriptText("abcdef", 3)).toBe("abc…");
  });

  it("selectHistory filters by since then takes the newest limit", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "a", timestamp: 100 },
      { role: "assistant", text: "b", timestamp: 200 },
      { role: "user", text: "c" },
    ];
    expect(selectHistory(entries, { since: 150 }).map((e) => e.text)).toEqual(["b"]);
    expect(selectHistory(entries, { limit: 2 }).map((e) => e.text)).toEqual(["b", "c"]);
    expect(selectHistory(entries)).toHaveLength(3);
  });
});

describe("parseCodexRollout", () => {
  // Shapes verified live against codex-cli 0.150.1 rollout files
  // (ids/text anonymized); envelope carries timestamp + ordinal.
  const rollout = [
    JSON.stringify({
      timestamp: 1789000000000,
      ordinal: 1,
      type: "session_meta",
      payload: { session_id: "thr_test", id: "thr_test" },
    }),
    JSON.stringify({
      timestamp: 1789000001000,
      ordinal: 2,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thr_test",
        item: {
          type: "UserMessage",
          id: "m1",
          content: [{ type: "input_text", text: "list files" }],
        },
      },
    }),
    JSON.stringify({
      timestamp: 1789000002000,
      ordinal: 3,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thr_test",
        item: {
          type: "CommandExecution",
          id: "c1",
          command: "ls",
          exit_code: 0,
          aggregated_output: "a.txt\n",
        },
      },
    }),
    JSON.stringify({
      timestamp: 1789000003000,
      ordinal: 4,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thr_test",
        item: { type: "Reasoning", id: "r1" },
      },
    }),
    JSON.stringify({
      timestamp: 1789000004000,
      ordinal: 5,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thr_test",
        item: {
          type: "AgentMessage",
          id: "m2",
          content: [{ type: "output_text", text: "done: a.txt" }],
        },
      },
    }),
    "not json{{{",
  ].join("\n");

  it("folds messages and compresses tools, skips reasoning and garbage", () => {
    expect(parseCodexRollout(rollout)).toEqual([
      { role: "user", text: "list files", timestamp: 1789000001000 },
      { role: "tool", toolName: "exec", text: "ls (exit 0)\na.txt", timestamp: 1789000002000 },
      { role: "assistant", text: "done: a.txt", timestamp: 1789000004000 },
    ]);
  });

  it("readCodexTranscript honors limit through the file path", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-cxroll-"));
    try {
      const day = join(base, "sessions", "2026", "09", "04");
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, "rollout-2026-09-04T09-57-39-thr_test.jsonl"), rollout);
      const entries = readCodexTranscript({ sessionId: "thr_test", codexHome: base, limit: 1 });
      expect(entries).toEqual([
        { role: "assistant", text: "done: a.txt", timestamp: 1789000004000 },
      ]);
      expect(readCodexTranscript({ sessionId: "thr_missing", codexHome: base })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("parseClaudeTranscript", () => {
  // Shapes mirror stream-json blocks (verified live on 2.1.112+).
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
      timestamp: 1789000001000,
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "ponder", signature: "x" },
          { type: "text", text: "hello" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
      timestamp: 1789000002000,
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
      },
      timestamp: 1789000003000,
    }),
    JSON.stringify({ type: "queue-operation", operation: "x" }),
  ].join("\n");

  it("folds text, pairs tool results with names, skips thinking and machinery", () => {
    expect(parseClaudeTranscript(transcript)).toEqual([
      { role: "user", text: "hi", timestamp: 1789000001000 },
      { role: "assistant", text: "hello", timestamp: 1789000002000 },
      { role: "tool", toolName: "Bash", text: "a.txt", timestamp: 1789000003000 },
    ]);
  });

  it("readClaudeTranscript misses gracefully without a store", () => {
    expect(
      readClaudeTranscript({ sessionId: "never-existed", homeDir: join(tmpdir(), "nope-xyz") }),
    ).toEqual([]);
  });
});

describe("readOpencodeTranscript", () => {
  it("reads message/part rows from opencode.db (skipped without node:sqlite)", async () => {
    // node < 22.5 has no built-in sqlite: the reader fails open, covered by
    // the corrupt-file case below.
    const sqlite = await import("node:sqlite").catch((): null => null);
    if (!sqlite) return;
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-ocdb-"));
    try {
      const db = new sqlite.DatabaseSync(join(base, "opencode.db"));
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);" +
          "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
      );
      const msg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
      const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
      msg.run("msg_u", "ses_test", 1789641894000, 1789641894000, JSON.stringify({ role: "user" }));
      part.run("p1", "msg_u", "ses_test", 1, 1, JSON.stringify({ type: "text", text: "hello db" }));
      msg.run(
        "msg_a",
        "ses_test",
        1789641895000,
        1789641895000,
        JSON.stringify({ role: "assistant" }),
      );
      part.run("p2", "msg_a", "ses_test", 2, 2, JSON.stringify({ type: "reasoning", text: "hmm" }));
      part.run(
        "p3",
        "msg_a",
        "ses_test",
        3,
        3,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "ok\n" },
        }),
      );
      part.run(
        "p4",
        "msg_a",
        "ses_test",
        4,
        4,
        JSON.stringify({ type: "tool", tool: "read", state: { status: "pending" } }),
      );
      db.close();
      // NOTE: verified live on 1.18.31 — message rows carry {role}, parts
      // carry {type:"text"|"tool"|"reasoning", text/tool/state}; step
      // markers, pending tools, and reasoning never surface.
      expect(await readOpencodeTranscript({ sessionId: "ses_test", dataDir: base })).toEqual([
        { role: "user", text: "hello db", timestamp: 1789641894000 },
        { role: "tool", toolName: "bash", text: "bash: ok", timestamp: 1789641895000 },
      ]);
      expect(await readOpencodeTranscript({ sessionId: "ses_missing", dataDir: base })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("bundled dist keeps a working node:sqlite reference (no import rewrite)", () => {
    // Regression: tsup/esbuild once rewrote `import("node:sqlite")` to
    // `import("sqlite")`, silently disabling history in dist builds.
    const text = readFileSync(join(process.cwd(), "dist", "index.js"), "utf-8");
    expect(text).toContain("node:sqlite");
    expect(text).not.toContain('import("sqlite")');
    expect(text).not.toContain("import('sqlite')");
  });

  it("fails open on missing or corrupt stores", async () => {
    expect(
      await readOpencodeTranscript({ sessionId: "x", dataDir: join(tmpdir(), "nope-xyz") }),
    ).toEqual([]);
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-ocdb-bad-"));
    try {
      writeFileSync(join(base, "opencode.db"), "not a database{{{");
      expect(await readOpencodeTranscript({ sessionId: "x", dataDir: base })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("session.history()", () => {
  it("fresh adapter sessions report [] without spawning", async () => {
    const { OpencodeSession } = await import("../runtimes/opencode/session.js");
    const { ClaudeSession } = await import("../runtimes/claude/session.js");
    const { CodexSession } = await import("../runtimes/codex/session.js");
    const { OpencodeAcpSession } = await import("../runtimes/opencode-acp/session.js");
    const cwd = process.cwd();
    await expect(new OpencodeSession({ id: "s", command: "opencode" }).history()).resolves.toEqual(
      [],
    );
    await expect(new ClaudeSession({ id: "s", command: "claude" }).history()).resolves.toEqual([]);
    await expect(new CodexSession({ id: "s", command: "codex" }).history()).resolves.toEqual([]);
    await expect(
      new OpencodeAcpSession({ id: "s", command: "opencode", cwd }).history(),
    ).resolves.toEqual([]);
  });
});

describe("transcript (live, guarded)", () => {
  it("codex: persisted rollouts parse to valid entries", () => {
    const root = join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return;
    // Some rollout files hold no completed items yet — scan until one yields.
    const tried = new Set<string>();
    for (const file of allRollouts(root)) {
      const sid = sessionIdOf(file);
      if (!sid || tried.has(sid)) continue;
      tried.add(sid);
      const entries = readCodexTranscript({ sessionId: sid });
      if (entries.length === 0) continue;
      for (const e of entries) {
        expect(["user", "assistant", "tool"]).toContain(e.role);
        expect(e.text.length).toBeGreaterThan(0);
      }
      return;
    }
  });

  it("claude: the verified live turn reads back", () => {
    // session_started 1609814a-… from the 2.1.276 end-to-end turn.
    const entries = readClaudeTranscript({
      sessionId: "1609814a-8d08-46e7-81f3-1af5912b1b50",
      cwd: "D:/AAA_Dev/agent-runtimes",
    });
    if (entries.length === 0) return; // transcript rotated away
    expect(entries.some((e) => e.role === "assistant" && e.text.includes("hi"))).toBe(true);
  });
});

function allRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= 20) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) out.push(join(dir, name));
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) walk(join(dir, name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function sessionIdOf(file: string): string | null {
  try {
    const text = readFileSync(file, "utf-8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const o = JSON.parse(line) as { type?: unknown; payload?: { session_id?: unknown } };
        if (o.type === "session_meta" && typeof o.payload?.session_id === "string") {
          return o.payload.session_id;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}
