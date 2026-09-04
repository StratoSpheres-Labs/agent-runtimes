import { describe, expect, it } from "vitest";
import { AcpTransport } from "../src/transport/acp.js";
import { AcpRun } from "../src/core/acp-run.js";

const mockScript = "tests/fixtures/acp-mock-server.mjs";

function transportFor(mode: string): AcpTransport {
  return new AcpTransport({ command: process.execPath, args: [mockScript, mode] });
}

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
