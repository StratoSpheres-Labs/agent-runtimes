import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAssistantUiBff } from "../examples/bff-assistant-ui.js";
import type {
  AgentRun,
  AgentSession,
  PermissionRequest,
  PermissionResponse,
  RuntimeEvent,
} from "../src/index.js";

/**
 * The example is the only runnable artifact of the transport's route contract,
 * so it gets covered — unlike `examples/bff-sse.ts`, which self-listens on
 * import and can only be exercised by hand.
 *
 * Everything runs against a stub session: no CLI, no network beyond localhost.
 */

type PermissionHandler = (req: PermissionRequest) => Promise<PermissionResponse>;

/**
 * One stubbed turn. `withGate: false` drops the permission event so a `hold`
 * test never has to answer it — otherwise the turn parks at its held delta
 * before it can ever reach the gate, and waiting for the gate deadlocks.
 */
function turnEvents(runId: string, withGate: boolean): RuntimeEvent[] {
  const gate: RuntimeEvent = {
    type: "permission_request",
    id: "toolu_42",
    toolName: "Bash",
    runId,
    options: [{ optionId: "allow_1", kind: "allow_once", label: "Allow once" }],
  };
  return [
    { type: "session_started", sessionId: "ses_stub", runId },
    { type: "text_delta", text: "hello", runId },
    ...(withGate ? [gate] : []),
    { type: "text_delta", text: " world", runId },
    { type: "usage", inputTokens: 3, outputTokens: 5, runId },
    { type: "done", runId },
  ];
}

interface Stub {
  session: AgentSession;
  runs: { closed: number; cancelled: number };
  /** Resolves once the turn is genuinely in flight (first event produced). */
  started: Promise<void>;
  /** Resolves once the turn has parked on its permission gate. */
  parked: Promise<void>;
  /** Wired by `serve` through the example's own injection seam. */
  setPermissionHandler(handler: PermissionHandler): void;
}

function stubSession(behavior: { hold?: boolean }): Stub {
  const runs = { closed: 0, cancelled: 0 };
  const withGate = behavior.hold !== true;

  let releaseHold: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markParked: () => void = () => {};
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });

  // Stands in for the CLI's own gate. The BFF supplies the real handler at
  // createSession time; without it, `/permission` could never be exercised.
  let handler: PermissionHandler = () => Promise.resolve({ optionId: "allow_1" });

  const session = {
    run(prompt: string): Promise<AgentRun> {
      const runId = `${prompt}:run1`;
      const events = turnEvents(runId, withGate);
      let done = false;
      return Promise.resolve({
        id: runId,
        get done(): boolean {
          return done;
        },
        async *events(): AsyncGenerator<RuntimeEvent, void, undefined> {
          for (const event of events) {
            markStarted();
            if (event.type === "permission_request") {
              // The event and the definition type are different shapes; the id
              // is the only field the route contract cares about.
              markParked();
              await handler(event as unknown as PermissionRequest);
              continue;
            }
            if (behavior.hold === true && event.type === "text_delta") {
              await held;
            }
            yield event;
          }
          done = true;
        },
        cancel(): Promise<void> {
          runs.cancelled += 1;
          releaseHold();
          return Promise.resolve();
        },
        result(): Promise<{ code: number; signal: null }> {
          return Promise.resolve({ code: 0, signal: null });
        },
        close(): Promise<void> {
          runs.closed += 1;
          releaseHold();
          return Promise.resolve();
        },
      });
    },
    cancel(): Promise<void> {
      runs.cancelled += 1;
      releaseHold();
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
    resume(): Promise<void> {
      return Promise.resolve();
    },
    get id(): string {
      return "stub-session";
    },
  };

  return {
    // The stub satisfies only the slice of `AgentSession` this example touches.
    session,
    runs,
    started,
    parked,
    setPermissionHandler(next: PermissionHandler): void {
      handler = next;
    },
  };
}

interface Harness {
  base: string;
  stub: Stub;
  close: () => Promise<void>;
}

async function serve(behavior: Parameters<typeof stubSession>[0] = {}): Promise<Harness> {
  const stub = stubSession(behavior);
  const bff = createAssistantUiBff({
    // The seam receives `{ cwd, onPermissionRequest }`; wiring the handler here
    // is what lets a stub reach the same permission path the CLI would.
    createSession: ({ onPermissionRequest }) => {
      stub.setPermissionHandler(onPermissionRequest);
      return Promise.resolve(stub.session);
    },
  });
  const server: Server = createServer((req, res) => {
    void bff.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    stub,
    close: async () => {
      await bff.close();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
    },
  };
}

function post(base: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Discriminants of an SSE body, in order. */
async function eventTypes(res: Response): Promise<string[]> {
  const body = await res.text();
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => (JSON.parse(l.slice(6)) as { type: string }).type);
}

describe("examples/bff-assistant-ui — the transport's route contract", () => {
  it("POST /turn streams SSE and ends on the terminal done", async () => {
    const h = await serve();
    try {
      // Answer the gate so the turn can finish.
      const turn = post(h.base, "/turn", { prompt: "hi", session: "s1" });
      await h.stub.parked;
      expect(
        (await post(h.base, "/permission", { id: "toolu_42", optionId: "allow_1" })).status,
      ).toBe(200);
      const res = await turn;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const types = await eventTypes(res);
      // One `data:` line per event — what the stream reader expects.
      expect(types.length).toBeGreaterThan(4);
      expect(types).toContain("text_delta");
      expect(types.at(-1)).toBe("done");
      // The run is closed, not leaked.
      expect(h.stub.runs.closed).toBe(1);
    } finally {
      await h.close();
    }
  }, 30000);

  it("rejects an empty prompt with 400 rather than starting a run", async () => {
    const h = await serve();
    try {
      expect((await post(h.base, "/turn", { prompt: "" })).status).toBe(400);
      expect(h.stub.runs.closed).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("answers a second concurrent turn with 409, never a parallel run", async () => {
    // The rule the whole slice rests on: a second run resumes a FRESH upstream
    // session and silently loses context.
    const h = await serve({ hold: true });
    try {
      const first = post(h.base, "/turn", { prompt: "one", session: "busy" });
      await h.stub.started;
      const second = await post(h.base, "/turn", { prompt: "two", session: "busy" });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toContain("drain");
      // Release the held turn so its response can finish.
      await post(h.base, "/cancel", { session: "busy" });
      await (await first).text();
      expect(h.stub.runs.closed).toBe(1);
    } finally {
      await h.close();
    }
  }, 30000);

  it("POST /cancel releases the parked run and closes it", async () => {
    const h = await serve({ hold: true });
    try {
      const turn = post(h.base, "/turn", { prompt: "long", session: "c1" });
      await h.stub.started;
      expect((await post(h.base, "/cancel", { session: "c1" })).status).toBe(200);
      await (await turn).text();
      expect(h.stub.runs.cancelled).toBe(1);
      // Closing is what keeps the BFF from leaking a child process.
      expect(h.stub.runs.closed).toBe(1);
    } finally {
      await h.close();
    }
  }, 30000);

  it("POST /permission resolves the gate by the id the event carried", async () => {
    const h = await serve();
    try {
      const turn = post(h.base, "/turn", { prompt: "ask", session: "p1" });
      await h.stub.parked;
      expect(
        (await post(h.base, "/permission", { id: "toolu_42", optionId: "allow_1" })).status,
      ).toBe(200);
      // With the gate answered the turn drains all the way to `done`.
      expect((await eventTypes(await turn)).at(-1)).toBe("done");
    } finally {
      await h.close();
    }
  }, 30000);

  it("POST /permission 404s a wrong id instead of silently dropping it", async () => {
    const h = await serve();
    try {
      // Loud: a 200 here would tell the UI an answer landed while the agent
      // stays parked forever.
      expect((await post(h.base, "/permission", { id: "not-pending", optionId: "x" })).status).toBe(
        404,
      );
    } finally {
      await h.close();
    }
  });

  it("404s an unknown route and a cancel for an unknown session", async () => {
    const h = await serve();
    try {
      expect((await fetch(`${h.base}/nope`)).status).toBe(404);
      expect((await post(h.base, "/cancel", { session: "never-opened" })).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("serves the browser-safe bundle, or explains that a build is missing", async () => {
    const h = await serve();
    try {
      const res = await fetch(`${h.base}/assistant-ui.js`);
      if (res.status === 200) {
        const text = await res.text();
        // The property that makes it browser-loadable at all.
        expect(text).not.toContain("node:");
        expect(text.length).toBeGreaterThan(1000);
      } else {
        // `pnpm build` not run yet — the message must say so, not 500.
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain("pnpm build");
      }
    } finally {
      await h.close();
    }
  });
});
