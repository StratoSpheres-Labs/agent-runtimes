// Minimal MCP stdio server for tests — speaks newline-delimited JSON-RPC:
// initialize, tools/list (one `echo` tool), tools/call. Honors ECHO_PREFIX
// env so tests can prove env delivery end to end.
let buf = "";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
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
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "0.0.1" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo back the input text",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
    } else if (msg.method === "tools/call") {
      const text = msg.params?.arguments?.text ?? "";
      const prefix = process.env.ECHO_PREFIX ?? "";
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `${prefix}ECHO:${text}` }] },
      });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } });
    }
    // notifications (initialized) need no answer
  }
});
process.stdin.on("end", () => process.exit(0));
