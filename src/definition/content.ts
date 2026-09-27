import type { ImageInput } from "./image.js";
import type { SeedMessage } from "./session-inputs.js";
import { truncateTranscriptText } from "./transcript.js";

/**
 * Structured prompt content — batch 2 input upgrade.
 * `run()` accepts either a plain string (single user text, today's
 * behavior) or an ordered part list (text/image interleaving). Adapters
 * split parts back into their native shapes (claude content blocks,
 * opencode `-f` files, codex `-i` files, ACP prompt parts) — callers never
 * see CLI flags (Rule 2).
 */
export interface PromptTextPart {
  type: "text";
  text: string;
}

/**
 * One image input as a prompt part. Same payload as `ImageInput`
 * (path-primary, or inline `data` + `mimeType`), tagged for the part list.
 */
export interface PromptImagePart extends ImageInput {
  type: "image";
}

export type PromptPart = PromptTextPart | PromptImagePart;

/** What `session.run()` / `run.send()` accept: plain text or part list. */
export type PromptContent = string | PromptPart[];

export interface SplitPrompt {
  /** Text parts joined with `\n` (a lone string passes through untouched). */
  text: string;
  /** Image parts (plus any `run`-level `images`, merged by the caller). */
  images: ImageInput[];
}

/**
 * Split caller input into native-ready text + images. Pure, testable.
 * A bare string yields zero images; image parts keep their `ImageInput`
 * payload (path resolution / temp staging stays adapter-side).
 */
export function splitPromptContent(input: PromptContent): SplitPrompt {
  if (typeof input === "string") return { text: input, images: [] };
  const texts: string[] = [];
  const images: ImageInput[] = [];
  for (const part of input) {
    if (part.type === "text") {
      texts.push(part.text);
    } else {
      // Rebuild the ImageInput payload explicitly (drops the `type` tag).
      images.push({
        path: part.path,
        data: part.data,
        mimeType: part.mimeType,
        filename: part.filename,
      });
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * Fold prior turns into a context block for seeding a fresh session.
 * No CLI has a transcript-injection channel (all resume paths need a
 * pre-existing native id), so seeding is a caller-side pattern: prepend
 * this block to the first prompt's text. Each message is truncated to the
 * transcript budget; images never survive the fold (text summary only).
 * Pure, testable.
 */
export function foldSeedMessages(messages: SeedMessage[]): string {
  return messages
    .map(
      (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${truncateTranscriptText(m.text)}`,
    )
    .join("\n");
}
