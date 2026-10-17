export interface LlmGeneratorSchema {
  /** Comma-separated: claude | agents | copilot (aliases: codex, openai-gpt → agents). */
  providers?: string;
}
