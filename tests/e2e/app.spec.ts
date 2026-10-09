import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const storageKey = "talksimul.sessions.v1";
const englishOriginal = "I goed to a café yesterday.";
const englishImproved = "I went to a café yesterday.";
const screenshotDir = resolve("docs/screenshots");

type PracticeTool = {
  name: string;
  execute: (input: unknown) => unknown;
};
type ToolHarnessWindow = Window & {
  __testPracticeTool?: PracticeTool;
  __testMicRequests?: number;
};

async function installPracticeContext(page: Page) {
  await page.addInitScript(() => {
    const state = window as ToolHarnessWindow;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: PracticeTool, options: { signal: AbortSignal }) {
          state.__testPracticeTool = tool;
          options.signal.addEventListener(
            "abort",
            () => {
              if (state.__testPracticeTool === tool)
                delete state.__testPracticeTool;
            },
            { once: true },
          );
        },
      },
    });
  });
}

async function executePracticeTool(page: Page, config: unknown) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ToolHarnessWindow).__testPracticeTool?.name,
      ),
    )
    .toBe("stage_conversation_practice");
  return page.evaluate(
    (input) => (window as ToolHarnessWindow).__testPracticeTool!.execute(input),
    config,
  );
}

test.beforeEach(async ({ page }) => {
  // Never send synthetic test utterances outside the machine or into a paid route.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        await route.abort();
        return;
      }
      if (request.method() === "POST" && url.pathname.startsWith("/api/")) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "E2E test: paid API calls are disabled.",
            code: "TEST_NO_EXTERNAL_API",
          }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    const tracking = window as unknown as { __testMicRequests: number };
    tracking.__testMicRequests = 0;
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          tracking.__testMicRequests += 1;
          throw new DOMException(
            "Synthetic E2E microphone denial",
            "NotAllowedError",
          );
        },
      });
    }
  });
});

async function openHome(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "어서 와요, 오늘도 한마디!" }),
  ).toBeVisible();
}

async function startFreeDemo(page: Page) {
  await page
    .getByRole("button", { name: "자유 대화 시작", exact: true })
    .click();
  await page
    .getByRole("button", { name: "데모로 둘러보기", exact: false })
    .click();
  await expect(
    page.getByRole("button", { name: "데모로 둘러보기", exact: false }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "데모 대화 시작", exact: true })
    .click();
  await expect(page.locator(".message-assistant")).toHaveCount(1);
}

async function say(page: Page, text: string) {
  const count = await page.locator(".message-user").count();
  const replies = await page.locator(".message-assistant").count();
  await page
    .getByRole("textbox", { name: "데모에서 직접 말할 문장 입력" })
    .fill(text);
  await page.getByRole("button", { name: "문장 보내기", exact: true }).click();
  await expect(page.locator(".message-user")).toHaveCount(count + 1);
  await expect(page.locator(".message-assistant")).toHaveCount(replies + 1);
}

async function finish(page: Page) {
  await page.locator(".finish-button").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "마치고 복기하기", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "한마디 더, 한 걸음 더." }),
  ).toBeVisible();
}

async function history(page: Page) {
  await page
    .getByRole("navigation", { name: "주 메뉴" })
    .getByRole("button", { name: "연습 기록", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "차곡차곡, 나의 이야기" }),
  ).toBeVisible();
}

async function noOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document, "document horizontal overflow").toBeLessThanOrEqual(
    widths.viewport + 1,
  );
  expect(widths.body, "body horizontal overflow").toBeLessThanOrEqual(
    widths.viewport + 1,
  );
}

async function screenshot(page: Page, name: string) {
  mkdirSync(screenshotDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(screenshotDir, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
}

test("English demo flows through hint, grounded review, clean retry, reload, history and deletion", async ({
  page,
}) => {
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\//.test(request.url()))
      paidRequests.push(request.url());
  });
  await openHome(page);
  await startFreeDemo(page);
  await say(page, englishOriginal);
  await page
    .getByRole("button", { name: "뭐라고 말하지?", exact: true })
    .click();
  const hintText = await page
    .getByRole("dialog")
    .locator(".hint-card p")
    .innerText();
  await expect(
    page
      .getByRole("dialog")
      .getByText("힌트는 내 발화로 기록되지 않아요.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "이제 말해 볼게요", exact: true })
    .click();
  await expect(page.locator(".message-user")).toHaveCount(1);
  await expect(page.locator(".message-user")).not.toContainText(hintText);
  await say(page, "I met my friend and had a latte.");
  await finish(page);
  await expect(page.locator(".original-expression").first()).toContainText(
    englishOriginal,
  );
  await expect(page.locator(".improved-expression").first()).toContainText(
    englishImproved,
  );
  await expect(page.locator(".improved-expression mark").first()).toHaveText(
    "went",
  );
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
    storageKey,
  );
  expect(saved).toHaveLength(1);
  expect(
    saved[0].messages.filter(
      (message: { role: string }) => message.role === "user",
    ),
  ).toHaveLength(2);
  expect(saved[0].review.feedback[0].original).toBe(englishOriginal);
  expect(saved[0].config).toMatchObject({
    language: "en",
    scenario: "free",
    mode: "demo",
  });

  await page
    .getByRole("button", { name: "같은 설정으로 다시 연습", exact: true })
    .click();
  await page
    .getByRole("button", { name: "데모 대화 시작", exact: true })
    .click();
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(page.locator(".message-user")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("button", { name: "TalkSimul 홈", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장하지 않고 나가기" })
    .click();
  await history(page);
  await expect(page.locator(".record-row")).toHaveCount(1);
  await page.reload();
  await history(page);
  await page.locator(".record-open").click();
  await expect(page.locator(".original-expression").first()).toContainText(
    englishOriginal,
  );
  await history(page);
  await page
    .getByRole("button", { name: "자유 대화 기록 삭제", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "기록 삭제", exact: true })
    .click();
  await expect(page.locator(".record-row")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "우리의 첫 이야기를 기다리고 있어요" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
      storageKey,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __testMicRequests: number }).__testMicRequests,
    ),
  ).toBe(0);
  expect(paidRequests).toEqual([]);
});

test("Japanese cafe applies challenge level, contextual hints and actual Japanese review", async ({
  page,
}) => {
  await openHome(page);
  await page.getByRole("button", { name: /일본어.*日本語/ }).click();
  await page
    .getByRole("button", { name: /カフェで注文.*카페에서 주문하기/ })
    .click();
  await page.getByRole("button", { name: /도전.*내 생각을 자유롭게/ }).click();
  await expect(page.locator(".prepare-context")).toContainText("일본어");
  await page.getByRole("button", { name: /데모로 둘러보기/ }).click();
  await page
    .getByRole("button", { name: "데모 대화 시작", exact: true })
    .click();
  await expect(page.locator(".session-tags")).toContainText("도전");
  await expect(page.locator(".message-assistant").first()).toContainText(
    "詳しく聞かせてください",
  );
  await say(page, "昨日、カフェに行きます。");
  await expect(page.locator(".message-assistant").last()).toContainText(
    "ホットとアイス",
  );
  await page
    .getByRole("button", { name: "뭐라고 말하지?", exact: true })
    .click();
  await expect(page.getByRole("dialog").locator(".hint-card")).toContainText(
    "アイスでお願いします。",
  );
  await page
    .getByRole("button", { name: "이제 말해 볼게요", exact: true })
    .click();
  await expect(page.locator(".message-user")).toHaveCount(1);
  await say(page, "アイスのカフェラテをお願いします。");
  await finish(page);
  await expect(page.locator(".original-expression").first()).toContainText(
    "昨日、カフェに行きます。",
  );
  await expect(page.locator(".improved-expression").first()).toContainText(
    "昨日、カフェに行きました。",
  );
  await expect(page.locator(".session-tags")).toContainText("일본어 · 도전");
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0],
    storageKey,
  );
  expect(saved.config).toEqual({
    language: "ja",
    level: "challenge",
    scenario: "cafe",
    mode: "demo",
  });
  expect(
    saved.review.feedback.every(
      (feedback: { messageId: string; original: string }) =>
        saved.messages.some(
          (message: { id: string; role: string; text: string }) =>
            message.id === feedback.messageId &&
            message.role === "user" &&
            message.text === feedback.original,
        ),
    ),
  ).toBe(true);
});

test("default live mode stays disabled when server AI is unavailable", async ({
  page,
}) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        configured: false,
        enabled: false,
        realtimeModel: "gpt-realtime-2.1",
        textModel: "gpt-5.4-mini",
      },
    }),
  );
  await openHome(page);
  await page
    .getByRole("button", { name: "자유 대화 시작", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /실시간 AI 음성 대화/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "마이크 켜고 대화 시작", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("서버의 AI 연결을 확인하고 있어요."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __testMicRequests: number }).__testMicRequests,
    ),
  ).toBe(0);
});

test("configured live mode still requires explicit session consent and never activates a microphone on selection", async ({
  page,
}) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        enabled: true,
        realtimeModel: "gpt-realtime-2.1",
        textModel: "gpt-5.4-mini",
      },
    }),
  );
  await openHome(page);
  await page
    .getByRole("button", { name: "자유 대화 시작", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /실시간 AI 음성 대화/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const start = page.getByRole("button", {
    name: "마이크 켜고 대화 시작",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "음성·대화 전송과 API 비용을 확인했어요." })
    .check();
  await expect(start).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __testMicRequests: number }).__testMicRequests,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: /데모로 둘러보기/ }).click();
  await page.getByRole("button", { name: /실시간 AI 음성 대화/ }).click();
  await expect(start).toBeDisabled();
});

test("WebMCP stages the requested practice settings and resets consent without starting voice", async ({
  page,
}) => {
  await installPracticeContext(page);
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        enabled: true,
        realtimeModel: "gpt-realtime-2.1",
        textModel: "gpt-5.4-mini",
      },
    }),
  );
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\//.test(request.url()))
      paidRequests.push(request.url());
  });
  await openHome(page);
  const config = {
    language: "ja",
    level: "challenge",
    scenario: "hotel",
    mode: "live",
  };
  expect(await executePracticeTool(page, config)).toEqual({
    page: "prepare",
    config,
    consentRequired: true,
    started: false,
  });
  await expect(
    page.getByRole("heading", { name: "우리, 이렇게 이야기해요" }),
  ).toBeVisible();
  await expect(page.locator(".prepare-context")).toContainText("일본어");
  await expect(page.locator(".prepare-context")).toContainText("호텔 체크인");
  await expect(
    page.getByRole("button", { name: /도전.*내 생각을 자유롭게/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /실시간 AI 음성 대화/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const consent = page.getByRole("checkbox", {
    name: "음성·대화 전송과 API 비용을 확인했어요.",
  });
  const start = page.getByRole("button", {
    name: "마이크 켜고 대화 시작",
    exact: true,
  });
  await expect(consent).not.toBeChecked();
  await expect(start).toBeDisabled();
  await consent.check();
  await expect(start).toBeEnabled();
  await executePracticeTool(page, {
    language: "en",
    level: "basic",
    scenario: "cafe",
    mode: "live",
  });
  await expect(page.locator(".prepare-context")).toContainText("영어");
  await expect(page.locator(".prepare-context")).toContainText(
    "카페에서 주문하기",
  );
  await expect(consent).not.toBeChecked();
  await expect(start).toBeDisabled();
  expect(
    await page.evaluate(() => (window as ToolHarnessWindow).__testMicRequests),
  ).toBe(0);
  expect(paidRequests).toEqual([]);
});

test("WebMCP refuses to replace an active conversation and preserves its transcript", async ({
  page,
}) => {
  await installPracticeContext(page);
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\//.test(request.url()))
      paidRequests.push(request.url());
  });
  await openHome(page);
  await startFreeDemo(page);
  await say(page, "I would like to keep this conversation.");
  await expect(
    executePracticeTool(page, {
      language: "ja",
      level: "challenge",
      scenario: "hotel",
      mode: "live",
    }),
  ).rejects.toThrow("End the active conversation on screen first.");
  await expect(page.locator(".session-page")).toBeVisible();
  await expect(page.locator(".prepare-page")).toHaveCount(0);
  await expect(page.locator(".message-user")).toHaveCount(1);
  await expect(page.locator(".message-user")).toContainText(
    "I would like to keep this conversation.",
  );
  await expect(
    page.getByRole("textbox", { name: "데모에서 직접 말할 문장 입력" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => (window as ToolHarnessWindow).__testMicRequests),
  ).toBe(0);
  expect(paidRequests).toEqual([]);
});

test("empty conversation is explicitly insufficient and has no invented corrections", async ({
  page,
}) => {
  await openHome(page);
  await startFreeDemo(page);
  await finish(page);
  await expect(page.locator(".insufficient-note")).toBeVisible();
  await expect(page.locator(".feedback-card")).toHaveCount(0);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0],
    storageKey,
  );
  expect(saved.review.insufficient).toBe(true);
  expect(saved.review.feedback).toEqual([]);
});

test("sufficient saved live review with no corrections preserves utterances and gives the correct guidance", async ({
  page,
}) => {
  const utterances = [
    "I enjoyed a quiet walk in the park.",
    "The weather was lovely, so I stayed outside for an hour.",
  ];
  await page.addInitScript(
    ({ key, texts }) => {
      localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "synthetic-live-no-corrections",
            config: {
              language: "en",
              level: "basic",
              scenario: "free",
              mode: "live",
            },
            startedAt: 1791500400000,
            duration: 35,
            messages: texts.map((text, index) => ({
              id: `synthetic-user-${index}`,
              role: "user",
              text,
              timestamp: 1791500400001 + index,
              source: "typed",
            })),
            review: {
              summary: "두 문장으로 하루의 이야기를 자연스럽게 전했어요.",
              insufficient: false,
              feedback: [],
              assessment: {
                delivery: "생각이 잘 전달돼요",
                naturalness: "자연스럽게 이어져요",
                grammar: "검토한 문장에 교정 제안이 없어요",
                vocabulary: "상황에 맞는 어휘를 사용했어요",
              },
            },
          },
        ]),
      );
    },
    { key: storageKey, texts: utterances },
  );
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\//.test(request.url()))
      paidRequests.push(request.url());
  });
  await openHome(page);
  await history(page);
  await page.locator(".record-open").click();
  await expect(
    page.getByRole("heading", { name: "추가 교정 제안은 없어요", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "아래 대화 원문과 보조 평가를 보며 내가 말한 표현을 다시 연습해 보세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("아직 돌아볼 문장이 없어요", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".insufficient-note")).toHaveCount(0);
  await expect(page.locator(".feedback-card")).toHaveCount(0);
  await expect(page.locator(".assessment")).toContainText("생각이 잘 전달돼요");
  await page.locator(".full-transcript summary").click();
  for (const text of utterances)
    await expect(
      page.locator(".full-transcript").getByText(text, { exact: true }),
    ).toBeVisible();
  const storedTexts = await page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem(key) ?? "[]")[0].messages.map(
        (message: { text: string }) => message.text,
      ),
    storageKey,
  );
  expect(storedTexts).toEqual(utterances);
  expect(paidRequests).toEqual([]);
});

test("storage quota failure leaves the current transcript review visible and offers retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "talksimul.sessions.v1")
        throw new DOMException("Synthetic storage quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await openHome(page);
  await startFreeDemo(page);
  await say(page, englishOriginal);
  await finish(page);
  await expect(page.getByRole("alert")).toContainText(
    "기록을 저장하지 못했어요.",
  );
  await expect(
    page.getByRole("button", { name: "저장 다시 시도" }),
  ).toBeVisible();
  await expect(page.locator(".original-expression").first()).toContainText(
    englishOriginal,
  );
});

test("a persisted interrupted review can be regenerated from its real transcript", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, original }) => {
      localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "synthetic-interrupted",
            config: {
              language: "en",
              level: "beginner",
              scenario: "free",
              mode: "demo",
            },
            startedAt: 1791500400000,
            duration: 10,
            messages: [
              {
                id: "synthetic-u1",
                role: "user",
                text: original,
                timestamp: 1791500400001,
                source: "typed",
              },
            ],
            review: null,
          },
        ]),
      );
    },
    { key: storageKey, original: englishOriginal },
  );
  await openHome(page);
  await history(page);
  await page.locator(".record-open").click();
  await page
    .getByRole("button", { name: "복기 다시 만들기", exact: true })
    .click();
  await expect(page.locator(".original-expression").first()).toContainText(
    englishOriginal,
  );
  await expect(page.locator(".improved-expression").first()).toContainText(
    englishImproved,
  );
});

test("leaving and deleting an in-flight review cancels it and cannot resurrect the record", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, original }) => {
      localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "synthetic-pending-live",
            config: {
              language: "en",
              level: "beginner",
              scenario: "free",
              mode: "live",
            },
            startedAt: 1791500400000,
            duration: 20,
            messages: [
              {
                id: "synthetic-u1",
                role: "user",
                text: original,
                timestamp: 1791500400001,
                source: "typed",
              },
              {
                id: "synthetic-u2",
                role: "user",
                text: "I enjoyed my coffee.",
                timestamp: 1791500400002,
                source: "typed",
              },
            ],
            review: null,
          },
        ]),
      );
    },
    { key: storageKey, original: englishOriginal },
  );

  let releaseResponse!: () => void;
  let markRequested!: () => void;
  let markHandled!: () => void;
  const deferredResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    markHandled = resolve;
  });
  // This local fulfillment replaces only the paid route guard. No network provider is used.
  await page.route("**/api/review", async (route) => {
    markRequested();
    await deferredResponse;
    try {
      await route.fulfill({
        json: {
          summary: "테스트용 지연 복기 응답",
          insufficient: false,
          feedback: [
            {
              messageId: "synthetic-u1",
              original: englishOriginal,
              improved: englishImproved,
              explanation: "테스트 응답",
              category: "시제",
            },
          ],
          assessment: {
            delivery: "테스트",
            naturalness: "테스트",
            grammar: "테스트",
            vocabulary: "테스트",
          },
        },
      });
    } finally {
      markHandled();
    }
  });

  await openHome(page);
  await history(page);
  await page.locator(".record-open").click();
  await page
    .getByRole("button", { name: "복기 다시 만들기", exact: true })
    .click();
  await requested;
  await expect(page.locator(".review-loading")).toBeVisible();
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().endsWith("/api/review"),
    timeout: 7000,
  });
  await history(page);
  await cancelled;
  await page
    .getByRole("button", { name: "자유 대화 기록 삭제", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "기록 삭제", exact: true })
    .click();
  releaseResponse();
  await handled;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".record-row")).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
      storageKey,
    ),
  ).toEqual([]);
});

test("asynchronous local hint speech failure is shown and conversation can resume", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type SyntheticUtterance = {
      text: string;
      onerror: ((event: { error: string }) => void) | null;
    };
    const tracking = window as unknown as {
      __testSpeech: { calls: number; errors: number; texts: string[] };
    };
    tracking.__testSpeech = { calls: 0, errors: 0, texts: [] };
    // Both objects are synthetic: no installed voice or real audio device is touched.
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        text: string;
        voice: unknown = null;
        lang = "";
        rate = 1;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [
          {
            name: "Synthetic local English",
            lang: "en-US",
            localService: true,
            default: true,
            voiceURI: "test-local-en",
          },
        ],
        cancel: () => {},
        speak: (utterance: SyntheticUtterance) => {
          tracking.__testSpeech.calls += 1;
          tracking.__testSpeech.texts.push(utterance.text);
          setTimeout(() => {
            tracking.__testSpeech.errors += 1;
            utterance.onerror?.({ error: "synthesis-failed" });
          }, 25);
        },
      },
    });
  });
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\//.test(request.url()))
      paidRequests.push(request.url());
  });
  await openHome(page);
  await startFreeDemo(page);
  await page
    .getByRole("button", { name: "뭐라고 말하지?", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const hintText = await dialog.locator(".hint-card p").innerText();
  await dialog.getByRole("button", { name: "발음 듣기", exact: true }).click();
  await expect(dialog.locator(".audio-notice")).toContainText(
    "기기 음성 재생에 실패했어요.",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __testSpeech: unknown }).__testSpeech,
    ),
  ).toEqual({ calls: 1, errors: 1, texts: [hintText] });
  await page
    .getByRole("button", { name: "이제 말해 볼게요", exact: true })
    .click();
  await expect(page.locator(".message-user")).toHaveCount(0);
  await expect(page.locator(".state-label")).toHaveText(
    "편하게 이야기해 주세요",
  );
  await say(page, "I would like a quiet afternoon.");
  await expect(page.locator(".message-user")).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __testMicRequests: number }).__testMicRequests,
    ),
  ).toBe(0);
  expect(paidRequests).toEqual([]);
});

test("keyboard dialog focus is contained and Escape restores the triggering button", async ({
  page,
}) => {
  await openHome(page);
  const settings = page.getByRole("button", {
    name: "연결 및 데이터 설정",
    exact: true,
  });
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    const focus = await dialog.evaluate((element) => ({
      inside: element.contains(document.activeElement),
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"),
      documentFocused: document.hasFocus(),
    }));
    expect(focus.inside, JSON.stringify(focus)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});

for (const width of [390, 768, 1440]) {
  test(`home, preparation, session, hint and review fit ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await openHome(page);
    await noOverflow(page);
    await screenshot(page, `home-${width}`);
    await page
      .getByRole("button", { name: "자유 대화 시작", exact: true })
      .click();
    await noOverflow(page);
    await expect(
      page.getByRole("button", { name: "마이크 켜고 대화 시작" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: /데모로 둘러보기/ }).click();
    await expect(
      page.getByRole("button", { name: "데모 대화 시작" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "데모 대화 시작" }).click();
    await say(page, englishOriginal);
    await say(page, "I enjoyed talking with my friend.");
    await noOverflow(page);
    await expect(page.locator(".session-controls")).toBeVisible();
    await screenshot(page, `session-${width}`);
    await page
      .getByRole("button", { name: "뭐라고 말하지?", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noOverflow(page);
    await page.getByRole("button", { name: "이제 말해 볼게요" }).click();
    await finish(page);
    await noOverflow(page);
    await screenshot(page, `review-${width}`);
  });
}
