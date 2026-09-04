/**
 * Minimal fake ACP agent for unit tests (no model, no network).
 * Mode: process.argv[2] — "turn" | "permission" | "fs" | "hang".
 * Speaks newline-delimited JSON-RPC on stdio. Exits 0 on stdin end.
 * Client-bound request ids use the 900s to avoid colliding with the
 * client-side id counter (which starts at 1).
 */
const mode = process.argv[2] || "turn";

let buf = "";
const pending = new Map();
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const upd = (update) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "ses_mock", update },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t, messageId = "m1") => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text: t },
});

async function onRequest(id, method, params) {
  if (method === "initialize") {
    result(id, {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "mock", version: "0" },
    });
    return;
  }
  if (method === "session/new") {
    result(id, { sessionId: "ses_mock" });
    return;
  }
  if (method === "session/cancel") {
    result(id, {});
    return;
  }
  if (method === "session/prompt") {
    await runTurn(id, params);
    return;
  }
  fail(id, -32601, `Method not implemented: ${method}`);
}

async function runTurn(id, params) {
  void params;
  if (mode === "hang") return; // never answer — exercises client timeout
  if (mode === "permission") {
    send({
      jsonrpc: "2.0",
      id: 901,
      method: "session/request_permission",
      params: {
        sessionId: "ses_mock",
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "deny", kind: "reject_once" },
        ],
      },
    });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(901);
        resolve("TIMEOUT");
      }, 10000);
      pending.set(901, (msg) => {
        clearTimeout(timer);
        resolve(JSON.stringify(msg.result !== undefined ? msg.result : msg.error));
      });
    });
    upd(text(`PERM-ANSWER:${answer}`));
    result(id, { stopReason: "end_turn" });
    return;
  }
  if (mode === "fs") {
    send({
      jsonrpc: "2.0",
      id: 902,
      method: "fs/read_text_file",
      params: { sessionId: "ses_mock", path: "/x" },
    });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(902);
        resolve("TIMEOUT");
      }, 10000);
      pending.set(902, (msg) => {
        clearTimeout(timer);
        resolve(JSON.stringify(msg.result !== undefined ? msg.result : msg.error));
      });
    });
    upd(text(`FS-ANSWER:${answer}`));
    result(id, { stopReason: "end_turn" });
    return;
  }
  // mode "turn": garbage line first (resilience), then a full happy turn.
  process.stdout.write("not json{{{\n");
  await sleep(10);
  upd({ sessionUpdate: "future_kind_xyz" });
  await sleep(10);
  upd({
    sessionUpdate: "agent_thought_chunk",
    messageId: "m1",
    content: { type: "text", text: "hmm" },
  });
  await sleep(10);
  upd(text("hi"));
  await sleep(10);
  upd(text(" there"));
  await sleep(10);
  upd({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "read",
    kind: "read",
    status: "pending",
    rawInput: { filePath: "a.txt" },
  });
  await sleep(10);
  upd({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    kind: "read",
    title: "read",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
  });
  await sleep(10);
  upd({ sessionUpdate: "usage_update", used: 5, size: 100 });
  await sleep(10);
  result(id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf-8");
  const parts = buf.split("\n");
  buf = parts.pop() ?? "";
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      if (resolve) resolve(msg);
      continue;
    }
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      void onRequest(msg.id, msg.method, msg.params);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
