/**
 * How the agent receives the prompt.
 * Maps to Dev_Docs/agent_runtimes_dev_plan.md Task 1.3
 * and backgrounds_from_chatgpt.md prompt-via-stdin discussion.
 */
export type PromptInput =
  | {
      /** Prompt passed as CLI argv (e.g. `claude "hello"`) */
      type: "argv";
    }
  | {
      /** Prompt piped via stdin — avoids argv length limits on Windows */
      type: "stdin";
    }
  | {
      /** Prompt written to a temp file whose path is passed */
      type: "file";
    };
