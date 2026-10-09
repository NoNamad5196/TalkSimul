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
      "설명 본문은 짧고 완결된 한국어 문장입니다. 필요한 외국어 표현만 따옴표로 인용합니다. 일본어 설명 뒤에 한글만 붙이지 않습니다.",
    );
const hintOutputSchema = z
  .object({
    text: outputText(1200),
    meaning: koreanOutputText(1200),
    note: koreanOutputText(1200),
  })
  .strict();

const reviewOutputSchema = z
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

// Use only representable checks in provider JSON Schema. The locale checks below
// run after parsing; they are a prose-format guard, not a language-quality score.
export const hintJsonSchema = z.toJSONSchema(hintOutputSchema, {
  target: "draft-7",
});
export const reviewJsonSchema = z.toJSONSchema(reviewOutputSchema, {
  target: "draft-7",
});

function isKoreanProse(value: string, shortTranslation = false): boolean {
  const prose = value.replace(
    /"[^"\r\n]*"|'[^'\r\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/g,
    (quote) => (/[가-힣]/.test(quote) ? quote : ""),
  );
  const hangul = prose.match(/[가-힣]/g)?.length ?? 0;
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  // Keep short translations such as "네." valid, while rejecting foreign prose
  // padded with one Hangul character. Common unquoted terms (e.g. went) may stay.
  if (shortTranslation && /^[가-힣]+$/.test(value.replace(/[^\p{L}]/gu, "")))
    return true;
  return hangul >= 3 && hangul / Math.max(letters, 1) >= 0.4;
}

export const hintSchema = hintOutputSchema.superRefine((hint, ctx) => {
  for (const field of ["meaning", "note"] as const) {
    if (!isKoreanProse(hint[field], field === "meaning")) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: "A concise Korean explanation is required",
      });
    }
  }
});

export const reviewSchema = reviewOutputSchema.superRefine((review, ctx) => {
  const fields: [string, (string | number)[]][] = [
    [review.summary, ["summary"]],
    ...review.feedback.map((feedback, index): [string, (string | number)[]] => [
      feedback.explanation,
      ["feedback", index, "explanation"],
    ]),
    ...Object.entries(review.assessment).map(
      ([field, value]): [string, (string | number)[]] => [
        value,
        ["assessment", field],
      ],
    ),
  ];
  for (const [value, path] of fields) {
    if (!isKoreanProse(value)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "A concise Korean explanation is required",
      });
    }
  }
});
