import { describe, expect, it } from "vitest";
import { NativeIdResumeGuard } from "../src/core/resume-guard.js";
import { RuntimeSessionError } from "../src/core/errors.js";

describe("NativeIdResumeGuard", () => {
  it("allows the first run unconditionally", () => {
    const g = new NativeIdResumeGuard();
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).not.toThrow();
  });

  it("refuses a second run while the first was never drained", () => {
    const g = new NativeIdResumeGuard();
    g.noteRunCreated();
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).toThrow(RuntimeSessionError);
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).toThrow(/not drained to done/);
  });

  it("allows a fresh start after the idless run drained to done", () => {
    const g = new NativeIdResumeGuard();
    g.noteRunCreated();
    g.noteEvent("error", false);
    g.noteEvent("done", false);
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).not.toThrow();
  });

  it("a captured id opens the gate even without a full drain", () => {
    const g = new NativeIdResumeGuard();
    g.noteRunCreated();
    g.noteEvent("session_started", false);
    expect(() => {
      g.assertCanStartRun("native_1", "s", "x");
    }).not.toThrow();
  });

  it("a new run resets the idless-drain state", () => {
    const g = new NativeIdResumeGuard();
    g.noteRunCreated();
    g.noteEvent("done", false); // run 1 drained idless → fresh start ok
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).not.toThrow();
    g.noteRunCreated(); // run 2 created, not drained
    expect(() => {
      g.assertCanStartRun(null, "s", "x");
    }).toThrow(/not drained to done/);
  });

  it("uses the thread noun for codex-flavored errors", () => {
    const g = new NativeIdResumeGuard();
    g.noteRunCreated();
    expect(() => {
      g.assertCanStartRun(null, "s", "codex", "thread");
    }).toThrow(/fresh upstream thread/);
  });
});
