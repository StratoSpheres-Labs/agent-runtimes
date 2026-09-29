import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRun } from "../src/core/run.js";
import { JsonlParser } from "../src/parser/jsonl.js";
import {
  appendJournalEvent,
  clearJournalSeqCache,
  compactJournalFile,
  journalIncomplete,
  readJournal,
  replayJournalEvents,
  stampJournalAborted,
  type RuntimeEvent,
} from "../src/index.js";
import { setSessionStoreDir } from "../src/core/session-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "journal-"));
  setSessionStoreDir(dir);
  clearJournalSeqCache();
});

afterEach(() => {
  setSessionStoreDir(null);
  clearJournalSeqCache();
  rmSync(dir, { recursive: true, force: true });
});

function textEvent(text: string): RuntimeEvent {
  return { type: "text_delta", text };
}

describe("run journal", () => {
  it("round-trips events with monotonic seqs", () => {
    appendJournalEvent("s1", textEvent("a"));
    appendJournalEvent("s1", textEvent("b"));
    appendJournalEvent("s1", { type: "done" });
    const lines = readJournal("s1");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(replayJournalEvents(lines)).toEqual([textEvent("a"), textEvent("b"), { type: "done" }]);
    expect(journalIncomplete(lines)).toBe(false);
  });

  it("skips torn tails and foreign lines", () => {
    appendJournalEvent("s2", textEvent("ok"));
    const file = join(dir, "s2.journal.ndjson");
    appendFileSync(file, '{"seq":2,"event":{"type":"text_delta","text":"half', "utf-8");
    appendFileSync(file, "\nnot json at all\n", "utf-8");
    const lines = readJournal("s2");
    expect(replayJournalEvents(lines)).toEqual([textEvent("ok")]);
    expect(journalIncomplete(lines)).toBe(true);
  });

  it("detects incomplete journals (crash shape: events, no done)", () => {
    expect(journalIncomplete([])).toBe(false);
    appendJournalEvent("s3", textEvent("x"));
    appendJournalEvent("s3", { type: "tool_started", id: "t", name: "n" });
    expect(journalIncomplete(readJournal("s3"))).toBe(true);
  });

  it("stamps aborted idempotently", () => {
    appendJournalEvent("s4", textEvent("x"));
    stampJournalAborted("s4");
    stampJournalAborted("s4");
    const lines = readJournal("s4");
    expect(lines.filter((l) => "aborted" in l)).toHaveLength(1);
    expect(journalIncomplete(lines)).toBe(false);
    // Complete journals are left alone.
    appendJournalEvent("s5", { type: "done" });
    stampJournalAborted("s5");
    expect(readJournal("s5")).toHaveLength(1);
  });

  it("compacts to the newest lines", () => {
    const file = join(dir, "compact.journal.ndjson");
    const body = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ seq: i + 1, event: textEvent(`e${String(i)}`) }),
    ).join("\n");
    writeFileSync(file, `${body}\n`, "utf-8");
    compactJournalFile(file, 3);
    const kept = readJournal("compact");
    expect(kept.map((l) => l.seq)).toEqual([8, 9, 10]);
  });

  it("reaps journals untouched past retention", () => {
    appendJournalEvent("s6", textEvent("old"));
    const file = join(dir, "s6.journal.ndjson");
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    utimesSync(file, past, past);
    expect(readJournal("s6")).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("append never throws on unwritable locations", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf-8");
    expect(() => {
      appendJournalEvent("s7", textEvent("x"), { dir: blocker });
    }).not.toThrow();
    expect(() => {
      stampJournalAborted("s7", { dir: blocker });
    }).not.toThrow();
  });

  it("DefaultRun journals stamped events end to end", async () => {
    const run = new DefaultRun("jsess:run1", {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify({ type: "text", text: "hi" }))})`],
      parser: new JsonlParser(),
      journalSessionId: "jsess",
    });
    run.spawn();
    for await (const e of run.events()) {
      if (e.type === "done") break;
    }
    await run.close();
    const events = replayJournalEvents(readJournal("jsess"));
    expect(events[0]).toMatchObject({ type: "text_delta", text: "hi", runId: "jsess:run1" });
    expect(events[events.length - 1]).toMatchObject({ type: "done", runId: "jsess:run1" });
    expect(journalIncomplete(readJournal("jsess"))).toBe(false);
  });

  it("missing journal reads as empty (never an error)", () => {
    expect(readJournal("nope")).toEqual([]);
  });
});
