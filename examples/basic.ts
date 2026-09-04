/**
 * Minimal DX demo — target API from Dev_Docs/agent_runtimes_dev_plan.md:15-33
 * Run: pnpm example  (tsx examples/basic.ts)
 *      or: pnpm build && node dist/index.js  (as library)
 * Requires `opencode` on PATH (`opencode --version`); skips gracefully otherwise.
 */

import { runtimes } from "../src/index.js";
import { OpencodeParser } from "../runtimes/opencode/parser.js";
import { buildOpencodeArgs } from "../runtimes/opencode/definition.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  // Phase 18 facade: pre-registered, returns the real OpencodeRuntime (not a stub).
  const runtime = await runtimes.resolve("opencode");

  const status = await runtime.detect();
  console.log("detect:", status);
  if (!status.installed) {
    console.log("opencode not installed — demo skipped");
    return;
  }
  console.log(`Using ${status.executable} ${status.version ?? ""}`);

  // Low-level demo: spawn + parse without Session
  // Spawn the absolute path from detect() — never the bare name (see docs/cross-platform.md §1).
  const args = buildOpencodeArgs({ format: "json" });
  const child = spawn(status.executable, [...args, "hi"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (child.stdin) child.stdin.end();

  const parser = new OpencodeParser();
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    const events = parser.parse(new Uint8Array(chunk));
    for (const e of events) {
      if (e.type === "text_delta") console.log("[text]", e.text);
      else if (e.type === "session_started") console.log("[session]", e.sessionId);
      else if (e.type === "done") console.log("[done]");
      else if (e.type === "error") console.log("[error]", e.error);
    }
  }
  for (const e of parser.flush()) {
    console.log("[flush]", e);
  }

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (c) => {
      resolve(c);
    });
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(null);
    }, 15_000);
  });
  console.log("exit:", code);

  // High-level Session demo — now wired to real opencode via OpencodeRuntime
  // Use a free model so `pnpm example` works without quota (opencode/mimo-v2.5-free)
  const opencodeRuntime = new OpencodeRuntime();
  const session = await opencodeRuntime.createSession({
    cwd: process.cwd(),
    model: "opencode/mimo-v2.5-free",
  });
  console.log("session:", session.id);
  const run = await session.run("hello from session");
  for await (const e of run.events()) {
    if (e.type === "text_delta") console.log("[session text]", e.text);
    else console.log("session event:", e.type);
    if (e.type === "done") break;
  }
  await run.result().catch(() => {});
  await session.close();
  console.log("done");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
