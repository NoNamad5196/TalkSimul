import { describe, expect, it } from "vitest";
import { demoHint, demoReply, demoReview, greeting } from "../src/lib/content";
import type { Message, SessionConfig } from "../shared/types";

const en: SessionConfig = {
  language: "en",
  level: "basic",
  scenario: "free",
  mode: "demo",
};
const ja: SessionConfig = { ...en, language: "ja" };
const message = (id: string, role: Message["role"], text: string): Message => ({
  id,
  role,
  text,
  timestamp: 1_700_000_000_000,
  source: role === "user" ? "typed" : "demo",
});

describe("explicit demo conversation content", () => {
  it("uses selected language, scenario and difficulty in the opening", () => {
    expect(greeting({ ...en, scenario: "cafe" })).toContain("drink");
    expect(greeting({ ...ja, scenario: "hotel" })).toContain("ご予約");
    expect(greeting({ ...en, level: "beginner" })).toContain(
      "How are you today?",
    );
    expect(greeting({ ...en, level: "challenge" })).toContain(
      "Tell me a little more",
    );
    expect(greeting({ ...ja, level: "challenge" })).toContain("詳しく");
  });

  it("keeps English and Japanese role replies aligned with the selected scenario", () => {
    expect(demoReply({ ...en, scenario: "cafe" }, [], "A latte")).toContain(
      "hot or iced",
    );
    expect(
      demoReply({ ...en, scenario: "hotel" }, [], "I have a reservation"),
    ).toContain("reservation");
    expect(demoReply({ ...ja, scenario: "cafe" }, [], "ラテ")).toContain(
      "ホットとアイス",
    );
    expect(
      demoReply({ ...ja, scenario: "hotel" }, [], "予約しました"),
    ).toContain("お名前");
  });

  it.each([
    [
      en,
      "Would you like that hot or iced?",
      "I'd like it iced, please.",
      "아이스로 주세요.",
    ],
    [
      ja,
      "ホットとアイス、どちらになさいますか？",
      "アイスでお願いします。",
      "아이스로 부탁드려요.",
    ],
  ])(
    "offers a context-specific hint without inserting a user utterance (%j)",
    (config, lastTurn, expected, meaning) => {
      const messages = [message("assistant-1", "assistant", lastTurn)];
      const before = structuredClone(messages);
      const hint = demoHint({ ...config, scenario: "cafe" }, messages);
      expect(hint).toMatchObject({ text: expected, meaning });
      expect(messages).toEqual(before);
      const review = demoReview(config, messages);
      expect(review.feedback).toEqual([]);
      expect(review.insufficient).toBe(true);
      expect(review.summary).toContain("아직 남긴 문장이 없어요");
    },
  );

  it("reviews only non-empty user messages and preserves their ids and verbatim wording", () => {
    const messages = [
      message(
        "assistant-1",
        "assistant",
        "I goed home. This is an assistant line.",
      ),
      message("user-1", "user", "I like coffee."),
      message("empty", "user", "   "),
      message(
        "assistant-2",
        "assistant",
        "A sample answer must not become feedback.",
      ),
      message("user-2", "user", "  I went to the park.  "),
    ];
    const review = demoReview(en, messages);
    expect(review.feedback.map((f) => [f.messageId, f.original])).toEqual([
      ["user-1", "I like coffee."],
      ["user-2", "  I went to the park.  "],
    ]);
    expect(review.insufficient).toBe(false);
    expect(review.summary).toContain("2개");
  });

  it.each([
    [
      en,
      "I goed to the cafe yesterday.",
      "I went to the cafe yesterday.",
      "시제",
    ],
    [ja, "昨日、公園に行きます。", "昨日、公園に行きました。", "말끝 · 시제"],
  ])(
    "ties a known grammar correction to its actual source utterance (%j)",
    (config, original, improved, category) => {
      const messages = [message("actual-user", "user", original)];
      const review = demoReview(config, messages);
      expect(review.feedback).toHaveLength(1);
      expect(review.feedback[0]).toMatchObject({
        messageId: "actual-user",
        original,
        improved,
        category,
      });
      expect(review.feedback[0].explanation).toContain("데모");
      expect(messages[0].text).toBe(original);
    },
  );

  it("does not fabricate corrections or AI scores for unknown demo sentences", () => {
    const longSentence =
      "I would like to explain a rather complicated experience that I had while travelling with friends. ".repeat(
        20,
      );
    const review = demoReview(en, [message("long-user", "user", longSentence)]);
    expect(review.feedback[0]).toMatchObject({
      original: longSentence,
      improved: longSentence,
    });
    expect(review.feedback[0].explanation).toContain("AI가 평가하지 않았어요");
    expect(
      Object.values(review.assessment).every((value) =>
        value.includes("평가 안 함"),
      ),
    ).toBe(true);
    expect(review.insufficient).toBe(true);
  });

  it("keeps retry review separate from the previous session", () => {
    const previous = [message("old-user", "user", "I goed to the hotel.")];
    const retry = [message("new-user", "user", "今日は元気です。")];
    demoReview(en, previous);
    const review = demoReview(ja, retry);
    expect(review.feedback.map((f) => f.messageId)).toEqual(["new-user"]);
    expect(JSON.stringify(review)).not.toContain("old-user");
    expect(JSON.stringify(review)).not.toContain("hotel");
  });

  it.each([en, ja])(
    "shows an insufficient state for an empty session (%j)",
    (config) => {
      const review = demoReview(config, []);
      expect(review.insufficient).toBe(true);
      expect(review.feedback).toEqual([]);
      expect(review.summary).toContain("아직 남긴 문장이 없어요");
      expect(
        Object.values(review.assessment).every((value) =>
          value.includes("평가 안 함"),
        ),
      ).toBe(true);
    },
  );
});
