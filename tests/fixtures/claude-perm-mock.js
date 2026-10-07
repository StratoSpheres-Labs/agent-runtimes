// Fake Claude Code CLI for the interactive-permission path.
//
// Emits the `stream-json` lines `ClaudeParser` understands, including an
// `AskUserQuestion` tool_use (which the parser turns into a
// `permission_request`), then keeps stdin OPEN so the session can deliver the
// answer envelope without an EPIPE. Exits only after stdin closes.
const lines = [
  {
    type: "system",
    subtype: "init",
    session_id: "sess_fake_1",
  },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_42",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Allow the edit?",
                options: [
                  { label: "Yes", kind: "allow_once" },
                  { label: "No", kind: "reject_once" },
                ],
              },
            ],
          },
        },
      ],
    },
  },
];

process.stdout.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

// Drain stdin so the answer envelope the session writes is accepted, then
// finish the turn.
let pending = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  if (pending.includes("tool_result")) {
    process.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      })}\n`,
    );
    process.stdout.write(`${JSON.stringify({ type: "result", total_cost_usd: 0 })}\n`);
    process.stdin.pause();
    process.exit(0);
  }
});
process.stdin.resume();
