/**
 * Minimal BFF cookbook — one SSE slice over agent-runtimes.
 *
 * Run: pnpm example:bff   (tsx examples/bff-sse.ts)
 * Open: http://localhost:3000 — type a prompt, watch events stream.
 *
 * Requires one agent CLI on PATH (`RUNTIME_ID`, default `opencode`);
 * without it the page explains what is missing instead of crashing.
 *
 * What this shows (see docs/dev/getting-started/bff.md):
 * - The backend holds Session/Run; the browser only ever sees NDJSON
 *   (`encodeRuntimeEvent` → `data: <line>`), never the library.
 * - One active run per session: a second turn while one streams gets
 *   409 — drain to `done` first, then ask again.
 * - `cancel()` ends with a terminal `done` (kill signal attached);
 *   `close()` alone would be silent teardown.
 * - `WireSendInput { runId, text }` routes to the live run's `send()`
 *   (ACP runtimes only — stdio CLIs reject loudly, surfaced as 400).
 * - `WireRespondPermission { id, optionId }` answers a `permission_request`
 *   the UI is showing (see `/permission`). The pending request is held
 *   backend-side and keyed by `PermissionRequest.id`, which is the same id the
 *   event carried — that is the only way the answer can be matched up.
 *
 * Permission answers stay backend-side (`onPermissionRequest` at
 * `createSession` / `run.respondToPermission`); this slice forwards
 * `permission_request` events downstream for display and routes the answer
 * back through `/permission`.
 *
 * Hard limit, stated plainly: a UI approval round trip only works where the
 * transport supplies a request id — claude (`AskUserQuestion`) does. ACP's
 * `session/request_permission` has none and `AcpRun` has no
 * `respondToPermission`, so `respondWithUi` answers inline and logs it
 * instead of faking a key that could never match.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  runtimes,
  encodeRuntimeEvent,
  type AgentRun,
  type AgentSession,
  type PermissionRequest,
  type PermissionResponse,
  type WireRespondPermission,
  type WireSendInput,
} from "../src/index.js";

const PORT = process.env["PORT"] ?? "3000";
const RUNTIME_ID = process.env["RUNTIME_ID"] ?? "opencode";

interface Entry {
  session: AgentSession;
  busy: boolean;
  /** runId → live run, recorded from the event stream as turns flow. */
  runs: Map<string, AgentRun>;
}

/**
 * Pending `permission_request` ids → their resolver. The agent parks until the
 * UI answers, so the answer has to be held somewhere the HTTP layer can reach:
 * `onPermissionRequest` cannot see the browser.
 *
 * Keyed by `PermissionRequest.id`, which is the SAME id as the
 * `permission_request` event's `id` — that is what lets `/permission` match an
 * answer to the request it is holding. Runtimes without one (ACP) cannot be
 * answered from the UI at all; see `respondWithUi` below.
 */
const pendingPermissions = new Map<string, (optionId: string) => void>();

/**
 * Only park the agent when the transport gave us an id the UI will also see.
 *
 * ACP's `session/request_permission` has no request id and `AcpRun` has no
 * `respondToPermission`, so a UI round trip could never be matched up. Rather
 * than invent a key (which would 404 on every click) we answer inline with the
 * first allow-style option and log why — an app that wants a real approval UI
 * there needs ACP-side support, not a workaround.
 */
function respondWithUi(req: PermissionRequest): Promise<PermissionResponse> {
  if (req.id === undefined) {
    console.warn(
      `[bff] '${req.method}' carries no request id — answering inline; ` +
        "a UI approval round trip is not possible for this runtime",
    );
    const allow = req.options.find((o) => /allow|yes|accept/i.test(`${o.kind} ${o.label ?? ""}`));
    return Promise.resolve({ optionId: (allow ?? req.options[0])?.optionId ?? "" });
  }
  return new Promise((resolve) => {
    pendingPermissions.set(req.id as string, (optionId) => {
      pendingPermissions.delete(req.id as string);
      resolve({ optionId });
    });
  });
}

const entries = new Map<string, Entry>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

/** One SSE turn: run the prompt, forward every event, end on `done`. */
async function streamTurn(entry: Entry, prompt: string, res: ServerResponse): Promise<void> {
  if (entry.busy) {
    sendJson(res, 409, {
      error: "session busy — drain the live turn to done before starting another",
    });
    return;
  }
  entry.busy = true;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let run: AgentRun | undefined;
  try {
    run = await entry.session.run(prompt);
    for await (const event of run.events()) {
      if (event.runId !== undefined) entry.runs.set(event.runId, run);
      res.write(`data: ${encodeRuntimeEvent(event)}`);
      if (event.type === "done") break;
    }
  } catch (err) {
    // Loud reject (unknown run, undrained predecessor, spawn failure) —
    // the UI surfaces it, never retries silently.
    res.write(
      `data: ${JSON.stringify({ type: "stream_error", message: err instanceof Error ? err.message : String(err) })}\n\n`,
    );
  } finally {
    entry.busy = false;
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
  if (req.method === "GET" && url.pathname === "/events") {
    const prompt = url.searchParams.get("prompt") ?? "";
    if (prompt === "") {
      sendJson(res, 400, { error: "query ?prompt= is required" });
      return;
    }
    const runtime = await runtimes.resolve(RUNTIME_ID);
    const status = await runtime.detect();
    if (!status.installed) {
      sendJson(res, 503, { error: `agent CLI '${RUNTIME_ID}' not found — install it, then retry` });
      return;
    }
    const key = url.searchParams.get("session") ?? "default";
    let entry = entries.get(key);
    if (entry === undefined) {
      const session = await runtime.createSession({
        cwd: process.cwd(),
        // Interactive turns park the agent until the UI answers. Without a
        // handler the agent would be auto-denied and the approval card would
        // never get a chance to render.
        onPermissionRequest: respondWithUi,
      });
      entry = { session, busy: false, runs: new Map() };
      entries.set(key, entry);
    }
    await streamTurn(entry, prompt, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/send") {
    const body = JSON.parse(await readBody(req)) as WireSendInput;
    let target: AgentRun | undefined;
    for (const entry of entries.values()) {
      const found = entry.runs.get(body.runId);
      if (found !== undefined) target = found;
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
      sendJson(res, 400, { error: "mid-run send() needs allowMidRunInput on an ACP runtime" });
      return;
    }
    await target.send(body.text);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/permission") {
    const body = JSON.parse(await readBody(req)) as WireRespondPermission;
    const resolve = pendingPermissions.get(body.id);
    if (resolve === undefined) {
      // Loud, and specific: a wrong id here almost always means the runtime
      // never supplied one (see `respondWithUi`).
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
  if (req.method === "POST" && url.pathname === "/cancel") {
    const body = JSON.parse(await readBody(req)) as { session?: string };
    const entry = entries.get(body.session ?? "default");
    if (entry === undefined) {
      sendJson(res, 404, { error: "unknown session" });
      return;
    }
    await entry.session.cancel();
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: "unknown route" });
}

/** Tiny demo UI: groups the stream by runId, folds thinking. */
const DEMO_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>bff-sse demo</title></head>
<body>
<input id="q" size="60" placeholder="ask the agent…">
<button id="go">run</button>
<button id="stop">cancel</button>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
let es = null;
document.getElementById("go").onclick = () => {
  out.textContent = "";
  es?.close();
  const prompt = document.getElementById("q").value;
  es = new EventSource("/events?prompt=" + encodeURIComponent(prompt));
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "text_delta") out.textContent += e.text ?? "";
    else if (e.type === "reasoning_delta") out.textContent += "\\n[thinking]\\n";
    else if (e.type === "tool_started") out.textContent += "\\n[tool " + e.name + "]\\n";
    else if (e.type === "error") out.textContent += "\\n[error " + e.error.code + "]\\n";
    else if (e.type === "permission_request") {
      out.textContent += "\\n[ask " + (e.toolName ?? "?") + "] ";
      if (confirm((e.prompt ?? "The agent asks permission") + "\\n\\n" +
          e.options.map((o) => o.label ?? o.optionId).join(" | "))) {
        fetch("/permission", { method: "POST", body: JSON.stringify({ id: e.id, optionId: e.options[0].optionId }) });
      } else {
        const deny = e.options.find((o) => /reject|deny|no/i.test(o.kind + " " + (o.label ?? "")));
        if (deny) fetch("/permission", { method: "POST", body: JSON.stringify({ id: e.id, optionId: deny.optionId }) });
      }
    }
    else if (e.type === "permission_denied") out.textContent += "\\n[blocked: " + (e.reason ?? "") + "]\\n";
    else if (e.type === "done") { out.textContent += "\\n[done]\\n"; es.close(); }
    else if (e.type === "stream_error") { out.textContent += "\\n[fail " + e.message + "]\\n"; es.close(); }
  };
};
document.getElementById("stop").onclick = () => {
  fetch("/cancel", { method: "POST", body: "{}" });
  es?.close();
};
</script>
</body></html>`;

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    if (!res.headersSent)
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`bff-sse demo on http://localhost:${PORT} (runtime: ${RUNTIME_ID})`);
});

process.on("SIGINT", () => {
  void (async () => {
    for (const entry of entries.values()) await entry.session.close().catch(() => {});
    server.close();
    process.exit(0);
  })();
});
