/**
 * BFF for the assistant-ui adapter — the runnable counterpart to
 * `src/frontend/assistant-ui/transport.ts`.
 *
 * Run:  pnpm example:bff-ui     (needs `pnpm build` first, for dist/assistant-ui.js)
 * Open: http://localhost:3000
 *
 * Why this file exists: `examples/bff-sse.ts` demonstrates raw SSE with
 * `EventSource`, which is a *different* contract — it serves `GET /events`,
 * while `createRuntimeTransport()` POSTs `{ prompt, session }` to `/turn`.
 * Nothing runnable implemented the transport's table until now, so the doc's
 * route contract could only be read, not run. This one can.
 *
 * The routes, exactly as `createRuntimeTransport` calls them:
 *
 * | Route              | Body                    | Notes                                  |
 * | ------------------ | ----------------------- | -------------------------------------- |
 * | `POST /turn`       | `{ prompt, session? }`  | SSE: `data: <encodeRuntimeEvent(e)>`    |
 * | `POST /cancel`     | `{ session?, runId? }`  | Ends the turn with a terminal `done`    |
 * | `POST /permission` | `WireRespondPermission` | Answers the parked `permission_request` |
 * | `POST /send`       | `WireSendInput`         | Mid-run steering — ACP runtimes only    |
 *
 * Plus two conveniences that are NOT part of the contract: `GET /` (the demo
 * page) and `GET /assistant-ui.js` (the browser-safe bundle, straight from
 * `dist/`, so the page can `import` it as a real ES module).
 *
 * Design notes worth copying into your own BFF:
 *
 * - **The browser never imports this package.** It gets `RuntimeEvent` NDJSON
 *   and nothing else; the Session, the CLI, and any credentials stay here.
 * - **One active run per session.** A second `/turn` while one streams is 409,
 *   never a parallel run — a second run would resume a *fresh* upstream session
 *   and silently lose context.
 * - **`cancel()` ends with `done`.** The UI stops on that event, not on the
 *   socket closing, so the browser-side `cancelling` state resolves instead of
 *   hanging.
 * - **Permission answers stay here.** The agent parks inside the CLI process;
 *   `onPermissionRequest` cannot see a browser, so the pending request is held
 *   in this module keyed by `PermissionRequest.id` — the same id the event
 *   carried, which is the only thing that can match an answer to its request.
 *
 * A demo page is not a product. `examples/` is not covered by the browser-safety
 * guard (`tests/assistant-ui-browser-safe.test.ts` walks `src/`), so this file
 * may use `node:http` freely — that is exactly why the bundle cannot.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodeRuntimeEvent,
  runtimes,
  type AgentRun,
  type AgentSession,
  type PermissionRequest,
  type PermissionResponse,
  type WireRespondPermission,
  type WireSendInput,
} from "../src/index.js";

export interface AssistantUiBffOptions {
  /** Registry id to resolve (default `opencode`). */
  readonly runtimeId?: string;
  /** Workspace the agent runs in (default `process.cwd()`). */
  readonly cwd?: string;
  /**
   * Session factory — the seam that makes this file testable without a CLI.
   *
   * It receives the SAME `{ cwd, onPermissionRequest }` the default path hands
   * to `createSession`, and that is load-bearing rather than tidy: an earlier
   * version of this seam took only `cwd`, which meant no test could ever reach
   * the permission plumbing — `/permission` then 404'd for reasons that had
   * nothing to do with the route. A seam that drops half the contract cannot
   * cover half the behaviour.
   */
  readonly createSession?: (options: {
    cwd: string;
    onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResponse>;
  }) => Promise<AgentSession>;
}

interface Entry {
  session: AgentSession;
  busy: boolean;
  /** The live run, so `/send` can steer it. */
  run?: AgentRun;
}

export interface AssistantUiBff {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Drain every session the BFF opened. */
  close(): Promise<void>;
}

export function createAssistantUiBff(options: AssistantUiBffOptions = {}): AssistantUiBff {
  const runtimeId = options.runtimeId ?? process.env["RUNTIME_ID"] ?? "opencode";
  const cwd = options.cwd ?? process.cwd();
  const entries = new Map<string, Entry>();
  /** `PermissionRequest.id` → its resolver. The agent is parked until this fires. */
  const pendingPermissions = new Map<string, (optionId: string) => void>();

  async function openSession(): Promise<AgentSession> {
    // Park the agent only when the transport gave us an id the UI will also see.
    // ACP's `session/request_permission` has none, so a UI round trip could
    // never be matched up — answer inline and say why, rather than invent a key
    // that would 404 on every click.
    const onPermissionRequest = (req: PermissionRequest): Promise<PermissionResponse> => {
      if (req.id === undefined) {
        console.warn(
          `[bff-ui] '${req.method}' carries no request id — answering inline; ` +
            "a UI approval round trip is not possible for this runtime",
        );
        const allow = req.options.find((o) =>
          /allow|yes|accept/i.test(`${o.kind} ${o.label ?? ""}`),
        );
        return Promise.resolve({ optionId: (allow ?? req.options[0])?.optionId ?? "" });
      }
      return new Promise((resolve) => {
        pendingPermissions.set(req.id as string, (optionId) => {
          pendingPermissions.delete(req.id as string);
          resolve({ optionId });
        });
      });
    };

    if (options.createSession !== undefined) {
      return options.createSession({ cwd, onPermissionRequest });
    }
    const runtime = await runtimes.resolve(runtimeId);
    const status = await runtime.detect();
    if (!status.installed) {
      throw new Error(`agent CLI '${runtimeId}' not found on PATH — install it, then retry`);
    }
    return runtime.createSession({ cwd, onPermissionRequest });
  }

  async function entryFor(key: string): Promise<Entry> {
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    const session = await openSession();
    const entry: Entry = { session, busy: false };
    entries.set(key, entry);
    return entry;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", reject);
    });
  }

  async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as { prompt?: string; session?: string };
    const prompt = body.prompt ?? "";
    if (prompt.length === 0) {
      sendJson(res, 400, { error: "prompt must not be empty" });
      return;
    }
    const entry = await entryFor(body.session ?? "default");
    if (entry.busy) {
      sendJson(res, 409, {
        error: "session busy — drain the live turn to `done` before starting another",
      });
      return;
    }
    entry.busy = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming.
      "X-Accel-Buffering": "no",
    });
    try {
      const run = await entry.session.run(prompt);
      entry.run = run;
      for await (const event of run.events()) {
        res.write(`data: ${encodeRuntimeEvent(event)}`);
        // `done` is terminal: end the response there so the browser's
        // `cancelling` state can settle instead of waiting on a closed socket.
        if (event.type === "done") break;
      }
    } catch (err) {
      // In-band, so the UI's own error surface shows it rather than a bare 500
      // after headers are already sent. `code` is what a consumer switches on.
      res.write(
        `data: ${encodeRuntimeEvent({
          type: "error",
          error: {
            code: "STREAM_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        })}`,
      );
    } finally {
      entry.busy = false;
      // Close the run exactly once, and only clear the slot AFTER reading it —
      // clearing first turned this into a no-op and leaked the child process.
      const run = entry.run;
      entry.run = undefined;
      await run?.close().catch(() => {});
      res.end();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DEMO_PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/assistant-ui.js") {
      // The browser-safe bundle, served verbatim. It has zero imports and zero
      // `node:` specifiers, so a browser can load it as a plain ES module —
      // which is the whole point of the subpath export.
      const bundle = join(process.cwd(), "dist", "assistant-ui.js");
      if (!existsSync(bundle)) {
        sendJson(res, 503, {
          error: "dist/assistant-ui.js missing — run `pnpm build` first",
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(bundle));
      return;
    }

    if (req.method === "POST" && url.pathname === "/turn") {
      await handleTurn(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/cancel") {
      const body = JSON.parse(await readBody(req)) as { session?: string };
      const entry = entries.get(body.session ?? "default");
      if (entry === undefined) {
        sendJson(res, 404, { error: "unknown session" });
        return;
      }
      // Resolves only once the run emits its terminal `done`; that is what
      // moves the browser out of `cancelling`.
      await entry.session.cancel();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/permission") {
      const body = JSON.parse(await readBody(req)) as WireRespondPermission;
      const resolve = pendingPermissions.get(body.id);
      if (resolve === undefined) {
        sendJson(res, 404, {
          error:
            `no pending permission '${body.id}' — already answered, expired, ` +
            "or this runtime supplies no request id (ACP cannot round-trip a UI approval)",
        });
        return;
      }
      resolve(body.optionId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/send") {
      const body = JSON.parse(await readBody(req)) as WireSendInput;
      let target: AgentRun | undefined;
      for (const entry of entries.values()) {
        if (entry.run?.id === body.runId) target = entry.run;
      }
      if (target === undefined) {
        sendJson(res, 404, { error: `unknown runId '${body.runId}'` });
        return;
      }
      if (target.done) {
        sendJson(res, 410, { error: "run already finished — start a new turn" });
        return;
      }
      if (target.send === undefined) {
        sendJson(res, 400, {
          error: "mid-run send() needs allowMidRunInput on an ACP runtime",
        });
        return;
      }
      await target.send(body.text);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "unknown route" });
  }

  return {
    handle,
    async close(): Promise<void> {
      for (const entry of entries.values()) await entry.session.close().catch(() => {});
      entries.clear();
      pendingPermissions.clear();
    },
  };
}

/**
 * Demo page: the framework-free half of the adapter.
 *
 * It uses `createThreadStore` + `createRuntimeTransport` directly instead of
 * assistant-ui's React hooks, because this repo carries no React dependency —
 * the same two objects are what `useExternalStoreRuntime` wraps, so what runs
 * here is the real path minus the hook. A React host adds the hook and drops
 * this file's rendering.
 */
const DEMO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>agent-runtimes · assistant-ui BFF</title>
<style>
 body { font: 14px/1.5 ui-monospace, monospace; margin: 0; padding: 24px; max-width: 900px; }
 #bar { display: flex; gap: 8px; margin-bottom: 16px; }
 input { flex: 1; padding: 8px; font: inherit; }
 button { padding: 8px 14px; font: inherit; cursor: pointer; }
 #state { font-size: 12px; opacity: .7; margin-bottom: 12px; }
 .msg { border-left: 3px solid #ccc; padding: 8px 12px; margin: 8px 0; white-space: pre-wrap; }
 .msg.user { border-color: #3b82f6; }
 .msg.assistant { border-color: #10b981; }
 .part { font-size: 12px; opacity: .75; margin: 2px 0; }
 .gate { border: 1px solid #f59e0b; padding: 8px; margin: 6px 0; }
</style></head>
<body>
<div id="bar">
  <input id="q" placeholder="ask the agent…">
  <button id="go">run</button>
  <button id="stop">stop</button>
</div>
<div id="state">idle</div>
<div id="out"></div>
<script type="module">
import { createThreadStore, createRuntimeTransport } from "/assistant-ui.js";

const out = document.getElementById("out");
const state = document.getElementById("state");

const store = createThreadStore({
  transport: createRuntimeTransport({
    endpoints: {
      turn: "/turn",
      cancel: "/cancel",
      permission: "/permission",
      send: "/send",
    },
    sessionId: "demo",
    onProtocolError: (err) => console.warn("[dropped a line]", err.message),
  }),
});

const ROLE = { user: "user", assistant: "assistant" };

function partText(part) {
  if (part.type === "text") return part.text;
  if (part.type === "reasoning") return null; // folded away below
  if (part.type === "tool-call") {
    const r = part.result === undefined ? "running" : JSON.stringify(part.result).slice(0, 120);
    return "[tool " + part.toolName + "] " + r;
  }
  return null;
}

function render() {
  const snap = store.getSnapshot();
  // The two states that make an empty/stalled thread explainable.
  state.textContent =
    snap.runState.type + " · load=" + snap.loadState.type +
    (snap.unhandledEvents.length ? " · " + snap.unhandledEvents.length + " dropped" : "");

  out.replaceChildren();
  for (const m of snap.messages) {
    const box = document.createElement("div");
    box.className = "msg " + (ROLE[m.role] ?? "");
    box.textContent = "[" + m.role + "] " + (m.status?.type ?? "");
    out.append(box);

    for (const part of m.content ?? []) {
      if (part.type === "reasoning") {
        const d = document.createElement("div");
        d.className = "part";
        d.textContent = "[thinking] " + String(part.text ?? "").slice(0, 120);
        box.append(d);
        continue;
      }
      const t = partText(part);
      if (t === null) continue;
      const line = document.createElement("div");
      line.textContent = t;
      box.append(line);

      // The approval gate: only rendered when a real permission_request
      // arrived for this run, and answered with the id the event carried.
      if (part.type === "tool-call" && part.approval && part.approval.approved === undefined) {
        const gate = document.createElement("div");
        gate.className = "gate";
        gate.textContent = (part.approval.prompt ?? "The agent asks permission") + " ";
        for (const opt of part.approval.options ?? []) {
          const b = document.createElement("button");
          b.textContent = opt.label ?? opt.optionId;
          b.onclick = () => store.respondToApproval({
            approvalId: part.approval.id,
            approved: opt.kind.startsWith("allow"),
            optionId: opt.optionId,
          });
          gate.append(b);
        }
        box.append(gate);
      }
    }
  }
}

store.subscribe(render);
render();

document.getElementById("go").onclick = () => {
  const text = document.getElementById("q").value;
  document.getElementById("q").value = "";
  store.send(text).catch((err) => {
    state.textContent = "send failed: " + err.message;
  });
};
document.getElementById("stop").onclick = () => {
  store.cancel().catch((err) => console.warn(err));
};
</script>
</body></html>`;

// Runnable directly (`pnpm example:bff-ui`) and importable from a test.
const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isMain) {
  const port = process.env["PORT"] ?? "3000";
  const bff = createAssistantUiBff();
  const server = createServer((req, res) => {
    bff.handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else res.end();
    });
  });
  server.listen(port, () => {
    console.log(`assistant-ui BFF on http://localhost:${port}`);
    console.log(`  runtime: ${process.env["RUNTIME_ID"] ?? "opencode"}`);
    if (!existsSync(join(process.cwd(), "dist", "assistant-ui.js"))) {
      console.warn("  dist/assistant-ui.js missing — run `pnpm build` or the page will 503");
    }
  });
  process.on("SIGINT", () => {
    void (async () => {
      await bff.close();
      server.close();
      process.exit(0);
    })();
  });
}
