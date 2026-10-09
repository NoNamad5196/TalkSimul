import { z } from "zod";

export const sessionConfigSchema = z
  .object({
    language: z.enum(["en", "ja"]),
    level: z.enum(["beginner", "basic", "challenge"]),
    scenario: z.enum(["free", "cafe", "hotel", "friends", "directions"]),
    mode: z.literal("live"),
  })
  .strict();

export const messageSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
    role: z.enum(["user", "assistant"]),
    text: z.string().max(8000),
    timestamp: z.number().finite().nonnegative(),
    source: z.enum(["voice", "typed", "demo"]).optional(),
  })
  .strict();

export const conversationSchema = z
  .object({
    config: sessionConfigSchema,
    messages: z.array(messageSchema).max(160),
  })
  .strict()
  .superRefine(({ messages }, ctx) => {
    if (
      new Set(messages.map((message) => message.id)).size !== messages.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate message IDs" });
    }
    if (
      messages.reduce((sum, message) => sum + message.text.length, 0) > 60000
    ) {
      ctx.addIssue({ code: "custom", message: "Conversation too long" });
    }
    if (messages.some((message) => message.source === "demo")) {
      ctx.addIssue({
        code: "custom",
        message: "Demo content cannot be submitted for live feedback",
      });
    }
  });

export const realtimeSchema = z
  .object({
    sdp: z
      .string()
      .min(10)
      .max(40000)
      .refine(
        (sdp) => sdp.startsWith("v=0") && /(?:^|\r?\n)m=audio /.test(sdp),
      ),
    config: sessionConfigSchema,
  })
  .strict();

export const speechSchema = z
  .object({
    config: sessionConfigSchema,
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

const outputText = (maximum: number) => z.string().trim().min(1).max(maximum);
const koreanOutputText = (maximum: number) =>
  outputText(maximum)
    .regex(/[가-힣]/)
    .describe(
      "한국어로 작성하는 설명입니다. 학습 언어가 일본어여도 한국어를 사용합니다.",
    );
export const hintSchema = z
  .object({
    text: outputText(1200),
    meaning: koreanOutputText(1200),
    note: koreanOutputText(1200),
  })
  .strict();

export const reviewSchema = z
  .object({
    summary: koreanOutputText(1600),
    feedback: z
      .array(
        z
          .object({
            messageId: outputText(160),
            original: z.string().min(1).max(8000),
            improved: outputText(8000),
            explanation: koreanOutputText(1600),
            category: z.enum([
              "시제",
              "문장 구조",
              "어휘",
              "자연스러움",
              "조사",
              "말끝",
              "경어",
              "상황 적절성",
            ]),
          })
          .strict(),
      )
      .max(5),
    assessment: z
      .object({
        delivery: koreanOutputText(800),
        naturalness: koreanOutputText(800),
        grammar: koreanOutputText(800),
        vocabulary: koreanOutputText(800),
      })
      .strict(),
    insufficient: z.boolean(),
  })
  .strict();

// Structured Outputs requires every field in an object to be required.
export const hintJsonSchema = z.toJSONSchema(hintSchema, { target: "draft-7" });
export const reviewJsonSchema = z.toJSONSchema(reviewSchema, {
  target: "draft-7",
});
