/**
 * Prompt budget helper — Sprint 2.
 * Windows CreateProcess caps argv at ~32767 chars (docs/cross-platform.md).
 * All three local runtimes (opencode/claude/codex) already use `input: stdin`
 * (PromptInput stdin), so argv is safe. This guard exists for the hypothetical
 * `argv` path and for very large stdin payloads (pipe buffer / memory).
 * Mirrors daemon's `prompt-budget.ts` (MAX_CHAT_IMAGE_BYTES etc.) but minimal.
 */

export const MAX_PROMPT_BYTES = 30_000;
export const MAX_PROMPT_HARD_BYTES = 200_000;

/**
 * Returns true if the prompt should be delivered via file (when the runtime
 * supports `promptViaFile`). For stdin runtimes this is a no-op — they can
 * stream via pipe — but we surface a warning for observability.
 */
export function shouldUseFileForPrompt(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf-8") > MAX_PROMPT_BYTES;
}

export function assertPromptWithinHardBudget(prompt: string): void {
  const bytes = Buffer.byteLength(prompt, "utf-8");
  if (bytes > MAX_PROMPT_HARD_BYTES) {
    throw new Error(
      `Prompt too large: ${String(bytes)} bytes exceeds hard budget ${String(MAX_PROMPT_HARD_BYTES)} — split or use file input`,
    );
  }
}
