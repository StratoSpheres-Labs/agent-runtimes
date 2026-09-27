import { describe, expect, it } from "vitest";
import { foldSeedMessages, splitPromptContent } from "../src/definition/content.js";
import type { PromptContent } from "../src/definition/content.js";
import { MAX_TRANSCRIPT_TEXT } from "../src/definition/transcript.js";

describe("splitPromptContent", () => {
  it("passes a bare string through with zero images", () => {
    expect(splitPromptContent("hello")).toEqual({ text: "hello", images: [] });
  });

  it("splits text and image parts, joining texts with newline", () => {
    const input: PromptContent = [
      { type: "text", text: "first" },
      { type: "image", path: "/tmp/a.png" },
      { type: "text", text: "second" },
    ];
    const out = splitPromptContent(input);
    expect(out.text).toBe("first\nsecond");
    expect(out.images).toEqual([
      { path: "/tmp/a.png", data: undefined, mimeType: undefined, filename: undefined },
    ]);
  });

  it("keeps inline image payloads intact", () => {
    const out = splitPromptContent([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", filename: "x.png" },
    ]);
    expect(out.text).toBe("");
    expect(out.images).toEqual([
      { path: undefined, data: "aGVsbG8=", mimeType: "image/png", filename: "x.png" },
    ]);
  });

  it("empty part list yields empty text and no images", () => {
    expect(splitPromptContent([])).toEqual({ text: "", images: [] });
  });
});

describe("foldSeedMessages", () => {
  it("folds turns into labeled lines", () => {
    expect(
      foldSeedMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ]),
    ).toBe("User: hi\nAssistant: hello");
  });

  it("empty input yields empty text", () => {
    expect(foldSeedMessages([])).toBe("");
  });

  it("truncates long messages to the transcript budget", () => {
    const out = foldSeedMessages([{ role: "user", text: "x".repeat(MAX_TRANSCRIPT_TEXT + 100) }]);
    expect(out.length).toBeLessThanOrEqual("User: ".length + MAX_TRANSCRIPT_TEXT + 1);
    expect(out.startsWith("User: ")).toBe(true);
  });

  it("keeps multi-line text intact", () => {
    expect(foldSeedMessages([{ role: "user", text: "a\nb" }])).toBe("User: a\nb");
  });
});
