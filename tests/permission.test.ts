import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpTransport } from "../src/transport/acp.js";
import { AcpRun } from "../src/core/acp-run.js";
import { ClaudeParser } from "../runtimes/claude/parser.js";

const mockScript = "tests/fixtures/acp-mock-server.mjs";

let cwd: string;
/** A platform-launchable path that runs the fake claude CLI. See the e2e case. */
let launcher: string;

beforeAll(() => {
  // Portable scratch dir — never hardcode C:\Temp (breaks macOS/Linux).
  cwd = mkdtempSync(join(tmpdir(), "agent-runtimes-perm-"));
  // `.js` NOT `.mjs`: `resolveShimTarget` recognises a node-script shim only by
  // a quoted `*.js` target, and falls through to "native binary" otherwise.
  const mock = join(process.cwd(), "tests", "fixtures", "claude-perm-mock.js");
  if (process.platform === "win32") {
    launcher = join(cwd, "fake-claude.cmd");
    writeFileSync(launcher, `@ECHO off\r\n"${process.execPath}" "${mock}" %*\r\n`);
  } else {
    launcher = join(cwd, "fake-claude");
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function transportFor(mode: string): AcpTransport {
  return new AcpTransport({ command: process.execPath, args: [mockScript, mode] });
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The claude `AskUserQuestion` line whose id must reach the handler. */
function askUserQuestionLine(id: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: "Allow edit?", options: [{ label: "Yes", kind: "allow_once" }] },
              ],
            },
          },
        ],
      },
    }) + "\n"
  );
}

describe("PermissionRequest.id", () => {
  it("the parser stamps the tool_use id on the event", () => {
    const parser = new ClaudeParser();
    const events = parser.parse(enc(askUserQuestionLine("toolu_42")));
    const event = events.find((e) => e.type === "permission_request");
    expect(event).toBeDefined();
    expect((event as { id: string }).id).toBe("toolu_42");
  });

  it("reaches onPermissionRequest through a real ClaudeSession turn", async () => {
    // The end-to-end half, and the only thing that actually pins the fix.
    // The UI approval round trip hinges on the backend being able to key its
    // pending map by an id the browser was also shown; if the event's id and
    // the handler's id diverge, every Allow click 404s. A parser-only
    // assertion would happily pass with `id: req.id` deleted from
    // claude/session.ts — this one would not.
    const { ClaudeSession } = await import("../runtimes/claude/session.js");
    const seen: Array<string | undefined> = [];
    const sess = new ClaudeSession({
      id: "perm_e2e",
      // ClaudeSession builds the claude argv itself, so the fake CLI has to be
      // reachable as a COMMAND. A platform launcher does that portably.
      command: launcher,
      cwd,
      onPermissionRequest: (req) => {
        seen.push(req.id);
        return { optionId: "Yes" };
      },
    });
    try {
      const run = await sess.run("ask me");
      const events = [];
      for await (const e of run.events()) {
        events.push(e);
        if (e.type === "done") break;
      }
      const event = events.find((e) => e.type === "permission_request");
      expect(event).toBeDefined();
      // The SAME id the browser is shown is the one the handler receives.
      expect(seen).toEqual([(event as { id: string }).id]);
      expect(seen[0]).toBe("toolu_42");
      // …and the answer actually reached the agent (the mock only finishes
      // once it reads the tool_result envelope off stdin).
      expect(events.some((e) => e.type === "done")).toBe(true);
    } finally {
      await sess.close();
    }
    // Spawns a real child and waits on a pipe hand-off: give it room on a
    // loaded box.
  }, 30000);

  it("stays optional — ACP supplies no request id and cannot round-trip a UI approval", async () => {
    // Documented limit, asserted so it stays a deliberate decision rather
    // than an accident: a backend must not invent a key here.
    const t = transportFor("permission");
    const run = new AcpRun("perm_no_id", {
      transport: t,
      cwd: process.cwd(),
      // eslint-disable-next-line @typescript-eslint/require-await
      onPermissionRequest: async (req) => {
        expect(req.id).toBeUndefined();
        expect(req.method).toBe("session/request_permission");
        return { optionId: "allow" };
      },
    });
    await run.start("hi");
    for await (const _ of run.events()) {
      expect(_.type).toBeTypeOf("string");
    }
    await run.close();
    // AcpRun has no respondToPermission slot — the handler is the only door.
    expect("respondToPermission" in run).toBe(false);
  });
});

describe("AcpTransport permission handler", () => {
  it("without handler returns -32601 (never stalls)", async () => {
    const t = transportFor("permission");
    const run = new AcpRun("perm_no_handler", { transport: t, cwd: process.cwd() });
    await run.start("hi");
    const evs: string[] = [];
    for await (const e of run.events()) {
      if (e.type === "text_delta") evs.push(e.text);
    }
    expect(evs.join("")).toContain("-32601");
    expect(evs.join("")).toContain("PERM-ANSWER");
    await run.close();
  });

  it("with handler the agent receives the chosen optionId", async () => {
    const t = transportFor("permission");
    const run = new AcpRun("perm_handler", {
      transport: t,
      cwd: process.cwd(),
      // eslint-disable-next-line @typescript-eslint/require-await
      onPermissionRequest: async (req) => {
        expect(req.method).toBe("session/request_permission");
        expect(req.options.map((o) => o.optionId)).toContain("allow");
        return { optionId: "allow" };
      },
    });
    await run.start("hi");
    const evs: string[] = [];
    for await (const e of run.events()) {
      if (e.type === "text_delta") evs.push(e.text);
    }
    expect(evs.join("")).toContain('"optionId":"allow"');
    await run.close();
  });

  it("fs without handler still -32601", async () => {
    const t = transportFor("fs");
    const run = new AcpRun("fs_no", { transport: t, cwd: process.cwd() });
    await run.start("hi");
    const evs: string[] = [];
    for await (const e of run.events()) {
      if (e.type === "text_delta") evs.push(e.text);
    }
    expect(evs.join("")).toContain("-32601");
    expect(evs.join("")).toContain("FS-ANSWER");
    await run.close();
  });
});
