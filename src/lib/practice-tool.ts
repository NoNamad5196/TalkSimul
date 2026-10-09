import type { SessionConfig } from "../../shared/types";

interface ToolContext {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: object;
      execute: (input: unknown) => unknown;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export function registerPracticeTool(
  stage: (config: SessionConfig) => unknown,
) {
  const context = (document as Document & { modelContext?: ToolContext })
    .modelContext;
  if (!context?.registerTool) return;
  const controller = new AbortController();
  const choices = {
    language: ["en", "ja"],
    level: ["beginner", "basic", "challenge"],
    scenario: ["free", "cafe", "hotel", "friends", "directions"],
    mode: ["demo", "live"],
  };
  try {
    void Promise.resolve(
      context.registerTool(
        {
          name: "stage_conversation_practice",
          title: "대화 연습 준비",
          description:
            "Choose language, level and topic, and open the practice preparation screen. Does not start a microphone, spend API credits, or accept consent; the user starts the conversation on screen.",
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(choices).map(([key, values]) => [
                key,
                { type: "string", enum: values },
              ]),
            ),
            required: Object.keys(choices),
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new Error("Invalid practice configuration");
            const value = input as Record<string, unknown>;
            if (
              Object.keys(value).length !== 4 ||
              !Object.entries(choices).every(
                ([key, values]) =>
                  typeof value[key] === "string" &&
                  values.includes(value[key] as string),
              )
            )
              throw new Error("Invalid practice configuration");
            return stage(value as unknown as SessionConfig);
          },
        },
        { signal: controller.signal },
      ),
    ).catch(() => {});
  } catch {
    controller.abort();
  }
  return () => controller.abort();
}
