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
// node:sqlite needs node >= 22.5; the VALUE is imported lazily inside the test
// so this file still loads on node 20. The type import is fully erased.
import type { DatabaseSync } from "node:sqlite";
import {
  redactSecrets,
  redactTranscriptEntries,
  selectHistory,
  toMs,
  truncateTranscriptText,
  type TranscriptEntry,
} from "../src/definition/transcript.js";
import { parseCodexRollout, readCodexTranscript } from "../runtimes/codex/transcript.js";
import { opencodeDbPath, readOpencodeTranscript } from "../runtimes/opencode/transcript.js";
import {
  findClaudeTranscript,
  parseClaudeTranscript,
  readClaudeTranscript,
} from "../runtimes/claude/transcript.js";

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

describe("redactSecrets", () => {
  it("masks vendor key shapes", () => {
    expect(redactSecrets("key sk-ant-abc123XYZ-_9 is here")).toBe("key [redacted] is here");
    expect(redactSecrets("proj sk-proj-0123456789abcdef end")).toBe("proj [redacted] end");
    expect(redactSecrets("id AKIAIOSFODNN7EXAMPLE ok")).toBe("id [redacted] ok");
    expect(redactSecrets("tok xoxb-1234-abcd-xyz now")).toBe("tok [redacted] now");
    expect(redactSecrets("ci ghp_abcdefghijklmnop done")).toBe("ci [redacted] done");
    expect(redactSecrets("openai gsk_abcdefghijklmnopqr go")).toBe("openai [redacted] go");
  });

  it("masks k=v secret nouns and bearer tokens", () => {
    expect(redactSecrets("api_key=hunter2 rest")).toBe("[redacted] rest");
    expect(redactSecrets("password: hunter2")).toBe("[redacted]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqr")).toBe(
      "Authorization: [redacted]",
    );
  });

  it("leaves ordinary prose alone", () => {
    expect(redactSecrets("check the token budget first")).toBe("check the token budget first");
    expect(redactSecrets("no secrets here, just text")).toBe("no secrets here, just text");
    expect(redactSecrets("")).toBe("");
  });
});

describe("redactTranscriptEntries", () => {
  const entries: TranscriptEntry[] = [{ role: "user", text: "api_key=hunter2 hi" }];
  it("masks by default and marks redacted", () => {
    expect(redactTranscriptEntries(entries)).toEqual([
      { role: "user", text: "[redacted] hi", redacted: true },
    ]);
  });
  it("passes through raw only on explicit opt-in", () => {
    expect(redactTranscriptEntries(entries, true)).toEqual([
      { role: "user", text: "api_key=hunter2 hi", redacted: false },
    ]);
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

  it("reads 0.156.1 content blocks (text/Text, verified live)", () => {
    // 0.156.1 rollout content blocks use `text` (user) / `Text`
    // (assistant); without these, history() folds to [] on current CLIs.
    const lines = [
      {
        timestamp: 1789000001000,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", id: "m1", content: [{ type: "text", text: "hi" }] },
        },
      },
      {
        timestamp: 1789000002000,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "AgentMessage", id: "m2", content: [{ type: "Text", text: "hello" }] },
        },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    expect(parseCodexRollout(lines)).toEqual([
      { role: "user", text: "hi", timestamp: 1789000001000 },
      { role: "assistant", text: "hello", timestamp: 1789000002000 },
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
        { role: "assistant", text: "done: a.txt", timestamp: 1789000004000, redacted: true },
      ]);
      expect(readCodexTranscript({ sessionId: "thr_missing", codexHome: base })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("findClaudeTranscript", () => {
  it("returns null for path-shaped session ids (no transcript-root escape)", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    try {
      for (const evil of ["../evil", "..\\evil", "a/b", "", "  "]) {
        expect(findClaudeTranscript({ sessionId: evil, homeDir: home })).toBeNull();
      }
      // A normal uuid simply misses (null) instead of throwing.
      expect(
        findClaudeTranscript({ sessionId: "6fd6faeb-a5da-48c2-ab2d-7691045af24b", homeDir: home }),
      ).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readClaudeTranscript redaction", () => {
  it("masks secrets by default, raw only on explicit opt-in", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-redact-"));
    try {
      // Scan path: <home>/.claude/projects/<slug>/<sessionId>.jsonl
      // (the finder only descends into subdirectories).
      const dir = join(home, ".claude", "projects", "test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "sid9.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "deploy with api_key=hunter2 now" },
        })}\n`,
      );
      expect(readClaudeTranscript({ sessionId: "sid9", homeDir: home })).toEqual([
        { role: "user", text: "deploy with [redacted] now", redacted: true },
      ]);
      expect(
        readClaudeTranscript({ sessionId: "sid9", homeDir: home, includeRawInputs: true }),
      ).toEqual([{ role: "user", text: "deploy with api_key=hunter2 now", redacted: false }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
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
        { role: "user", text: "hello db", timestamp: 1789641894000, redacted: true },
        {
          role: "tool",
          toolName: "bash",
          text: "bash: ok",
          timestamp: 1789641895000,
          redacted: true,
        },
      ]);
      expect(await readOpencodeTranscript({ sessionId: "ses_missing", dataDir: base })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  describe("sub-agent transcripts (opencode)", () => {
    /** node:sqlite is optional (node >= 22.5); skip cleanly when absent. */
    async function sqliteOrSkip(): Promise<{ DatabaseSync: typeof DatabaseSync } | null> {
      return await import("node:sqlite").catch((): null => null);
    }

    /**
     * Build a store shaped like a real opencode one: a parent session whose
     * assistant dispatched two `task` calls, each naming a child session in its
     * output, plus one orphan child with no task part at all.
     */
    async function seed(): Promise<string> {
      const sqlite = await sqliteOrSkip();
      if (!sqlite) throw new Error("skip");
      const base = mkdtempSync(join(tmpdir(), "agent-runtimes-sub-"));
      const db = new sqlite.DatabaseSync(join(base, "opencode.db"));
      db.exec(
        "CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER);" +
          "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);" +
          "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
      );
      const msg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
      const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
      const ses = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");

      ses.run("ses_parent", "p", null, "root", null, 1000);
      ses.run("ses_child_a", "p", "ses_parent", "Explore X (@explore subagent)", "explore", 1100);
      ses.run("ses_child_b", "p", "ses_parent", "Audit Y (@general subagent)", "general", 1200);
      // No task part ever names this one — must be dropped, not guessed onto one.
      ses.run("ses_orphan", "p", "ses_parent", "Orphan", "explore", 1300);
      // A grandchild under child A, for the depth test.
      ses.run("ses_grandchild", "p", "ses_child_a", "Deep dive", "explore", 1150);

      msg.run("msg_u", "ses_parent", 2000, 2000, JSON.stringify({ role: "user" }));
      part.run("p1", "msg_u", "ses_parent", 1, 1, JSON.stringify({ type: "text", text: "go" }));
      msg.run("msg_a", "ses_parent", 3000, 3000, JSON.stringify({ role: "assistant" }));
      // A tool part that mentions a child id but is NOT a `task` call, inserted
      // BEFORE the task parts on purpose. Correlation takes the first match, so
      // without the `task`-only restriction this part would win and wrongly
      // become the parent of `ses_child_b`. Appending it last would let the test
      // pass for the wrong reason.
      part.run(
        "p0",
        "msg_a",
        "ses_parent",
        0,
        0,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          callID: "call_c",
          state: { status: "completed", output: "grep ses_child_b" },
        }),
      );
      part.run(
        "p2",
        "msg_a",
        "ses_parent",
        2,
        2,
        JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "call_a",
          state: {
            status: "completed",
            input: { description: "Explore X", subagent_type: "explore" },
            output: '<task id="ses_child_a" state="completed">done</task>',
          },
        }),
      );
      part.run(
        "p3",
        "msg_a",
        "ses_parent",
        3,
        3,
        JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "call_b",
          state: {
            status: "completed",
            input: { description: "Audit Y" },
            output: '<task id="ses_child_b" state="completed">ok</task>',
          },
        }),
      );
      for (const [id, sid, text] of [
        ["m_a1", "ses_child_a", "child A answer"],
        ["m_b1", "ses_child_b", "child B answer"],
        ["m_g1", "ses_grandchild", "grandchild answer"],
        ["m_o1", "ses_orphan", "orphan answer"],
      ] as const) {
        msg.run(id, sid, 4000, 4000, JSON.stringify({ role: "assistant" }));
        part.run(`${id}_p`, id, sid, 1, 1, JSON.stringify({ type: "text", text }));
      }
      // Child A dispatched its own sub-agent, so depth is observable.
      msg.run("m_a2", "ses_child_a", 5000, 5000, JSON.stringify({ role: "assistant" }));
      part.run(
        "m_a2_p",
        "m_a2",
        "ses_child_a",
        1,
        1,
        JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "call_a2",
          state: { status: "completed", output: '<task id="ses_grandchild">x</task>' },
        }),
      );
      db.close();
      return base;
    }

    async function withSeed(run: (base: string) => Promise<void>): Promise<{ skipped: boolean }> {
      if ((await sqliteOrSkip()) === null) return { skipped: true };
      const base = await seed();
      try {
        await run(base);
        return { skipped: false };
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    it("omits sub-agents by default (opt-in)", async () => {
      await withSeed(async (base) => {
        const entries = await readOpencodeTranscript({ sessionId: "ses_parent", dataDir: base });
        // Nothing may grow without an explicit request.
        for (const e of entries) expect(e.subAgents).toBeUndefined();
      });
    });

    it("nests a child under the task call that dispatched it", async () => {
      await withSeed(async (base) => {
        const entries = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
          maxDepth: 0,
        });
        const tasks = entries.filter((e) => e.toolName === "task");
        expect(tasks).toHaveLength(2);
        const first = tasks[0]?.subAgents;
        expect(first).toHaveLength(1);
        expect(first?.[0]).toMatchObject({
          id: "ses_child_a",
          name: "explore",
          title: "Explore X (@explore subagent)",
          depth: 0,
        });
        // The child folded its own entries, including the `task` call it made —
        // it is a transcript, not a summary.
        expect(first?.[0]?.entries.map((e) => e.text)).toContain("child A answer");
        expect(first?.[0]?.entries.some((e) => e.toolName === "task")).toBe(true);
      });
    });

    it("never attaches a child to a non-task tool part", async () => {
      await withSeed(async (base) => {
        const entries = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
          maxDepth: 0,
        });
        const bash = entries.find((e) => e.toolName === "bash");
        // `call_c`'s output mentions ses_child_b and it is stored BEFORE the
        // task parts, so without the `task`-only restriction it would win the
        // correlation. It must not become a parent.
        expect(bash).toBeDefined();
        expect(bash?.subAgents).toBeUndefined();
        // …and the child must still be attached to its real task call.
        expect(entries.flatMap((e) => e.subAgents ?? []).map((s) => s.id)).toContain("ses_child_b");
      });
    });

    it("drops an unlinkable child instead of guessing a parent", async () => {
      await withSeed(async (base) => {
        const entries = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
        });
        const ids = entries.flatMap((e) => (e.subAgents ?? []).map((s) => s.id));
        // Measured live: 65/76 children tie cleanly, 11 do not. Those are dropped.
        expect(ids).toContain("ses_child_a");
        expect(ids).toContain("ses_child_b");
        expect(ids).not.toContain("ses_orphan");
        expect(JSON.stringify(entries)).not.toContain("orphan answer");
      });
    });

    it("expands grandchildren only while depth allows", async () => {
      await withSeed(async (base) => {
        const shallow = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
          maxDepth: 0,
        });
        const childA = shallow
          .flatMap((e) => e.subAgents ?? [])
          .find((s) => s.id === "ses_child_a");
        expect(childA?.entries.some((e) => e.subAgents !== undefined)).toBe(false);

        const deep = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
          maxDepth: 2,
        });
        const deepChild = deep
          .flatMap((e) => e.subAgents ?? [])
          .find((s) => s.id === "ses_child_a");
        const grand = deepChild?.entries.flatMap((e) => e.subAgents ?? []);
        expect(grand?.map((g) => g.id)).toContain("ses_grandchild");
      });
    });

    it("redacts inside nested transcripts too", async () => {
      await withSeed(async (base) => {
        const entries = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
          maxDepth: 1,
        });
        const nested = entries.flatMap((e) => e.subAgents ?? []);
        expect(nested.length).toBeGreaterThan(0);
        // A flat redact pass would mark the parent `redacted: true` and leave
        // every sub-agent entry untouched — the exact shape that makes a caller
        // believe the whole tree was scrubbed.
        for (const sub of nested) {
          for (const inner of sub.entries) {
            expect(inner.redacted).toBe(true);
          }
        }
      });
    });

    it("clamps a nonsense maxDepth instead of throwing or hanging", async () => {
      await withSeed(async (base) => {
        for (const maxDepth of [-5, Number.NaN, 0.9]) {
          const entries = await readOpencodeTranscript({
            sessionId: "ses_parent",
            dataDir: base,
            includeSubAgents: true,
            maxDepth,
          });
          expect(Array.isArray(entries)).toBe(true);
        }
      });
    });

    it("degrades to [] on a store with no session table (schema drift)", async () => {
      await withSeed(async (base) => {
        const sqlite = await sqliteOrSkip();
        if (!sqlite) return;
        const db = new sqlite.DatabaseSync(join(base, "opencode.db"));
        db.exec("DROP TABLE session;");
        db.close();
        const entries = await readOpencodeTranscript({
          sessionId: "ses_parent",
          dataDir: base,
          includeSubAgents: true,
        });
        // The parent transcript still reads; sub-agents quietly vanish.
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((e) => e.subAgents === undefined)).toBe(true);
      });
    });
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
  }, 30000);
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
  /** node:sqlite is optional (node >= 22.5); live legs skip without it. */
  async function sqliteOrSkip(): Promise<{ DatabaseSync: typeof DatabaseSync } | null> {
    return await import("node:sqlite").catch((): null => null);
  }

  /** Default opencode store path, or undefined when this box has none. */
  function liveOpencodeDb(): string | undefined {
    const path = opencodeDbPath();
    return existsSync(path) ? path : undefined;
  }
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
  }, 30000);

  it("opencode: real dispatched sub-agents nest under their task call", async () => {
    // The store used here had 76 child sessions across 38 parents; a parent
    // with children is discovered rather than hard-coded so this keeps working
    // as transcripts rotate.
    const base = liveOpencodeDb();
    if (base === undefined) return;
    const sqlite = await sqliteOrSkip();
    if (!sqlite) return;
    let parent: string | undefined;
    try {
      const db = new sqlite.DatabaseSync(base, { readOnly: true });
      parent = (
        db
          .prepare(
            "SELECT parent_id AS p FROM session WHERE parent_id IS NOT NULL GROUP BY parent_id ORDER BY COUNT(*) DESC LIMIT 1",
          )
          .get() as { p?: string } | undefined
      )?.p;
      db.close();
    } catch {
      return;
    }
    if (!parent) return;

    const nested = await readOpencodeTranscript({
      sessionId: parent,
      includeSubAgents: true,
      maxDepth: 0,
    });
    const subs = nested.flatMap((e) => e.subAgents ?? []);
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) {
      expect(sub.id).toMatch(/^ses_/);
      expect(sub.depth).toBe(0);
      // Redaction must have reached the nested text on a real store too.
      for (const inner of sub.entries) expect(inner.redacted).toBe(true);
    }
    // Only `task` ever dispatches a sub-agent — verified across every parent.
    for (const e of nested) {
      if (e.subAgents !== undefined) expect(e.toolName).toBe("task");
    }
  }, 30000);

  it("claude: the verified live turn reads back", () => {
    // session_started 1609814a-… from the 2.1.276 end-to-end turn.
    const entries = readClaudeTranscript({
      sessionId: "1609814a-8d08-46e7-81f3-1af5912b1b50",
      cwd: "D:/AAA_Dev/agent-runtimes",
    });
    if (entries.length === 0) return; // transcript rotated away
    expect(entries.some((e) => e.role === "assistant" && e.text.includes("hi"))).toBe(true);
  }, 30000);
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
