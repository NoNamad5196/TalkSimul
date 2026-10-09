import { afterEach, describe, expect, it, vi } from "vitest";
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { createApp, type AppOptions } from "./app";
import { readConfig, type ServerConfig } from "./config";
import {
  hasEnoughEvidence,
  isGroundedReview,
  realtimeSession,
} from "./prompts";
import type { Message, Review, SessionConfig } from "../shared/types";

const configuration: ServerConfig = {
  apiKey: "test-server-secret-never-expose",
  enabled: true,
  realtimeModel: "gpt-realtime-2.1",
  textModel: "gpt-5.4-mini",
  transcriptionModel: "gpt-4o-mini-transcribe",
  runtime: "local",
  trustedOrigins: [],
};
const session: SessionConfig = {
  language: "en",
  level: "beginner",
  scenario: "cafe",
  mode: "live",
};
const messages: Message[] = [
  {
    id: "a1",
    role: "assistant",
    text: "What would you like?",
    timestamp: 1,
    source: "voice",
  },
  {
    id: "u1",
    role: "user",
    text: "I want a coffee please.",
    timestamp: 2,
    source: "voice",
  },
  {
    id: "u2",
    role: "user",
    text: "I go to park yesterday.",
    timestamp: 3,
    source: "voice",
  },
];
const review: Review = {
  summary: "원하는 음료를 말하고 어제 한 일을 이야기했어요.",
  insufficient: false,
  feedback: [
    {
      messageId: "u2",
      original: "I go to park yesterday.",
      improved: "I went to the park yesterday.",
      category: "시제",
      explanation: "어제 한 일에는 과거형 went를 써요.",
    },
  ],
  assessment: {
    delivery: "주제가 전달돼요.",
    naturalness: "짧게 뜻을 전달했어요.",
    grammar: "과거형을 연습해 봐요.",
    vocabulary: "일상 어휘를 사용했어요.",
  },
};
const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const origin = "http://127.0.0.1:5188";
const servers: Server[] = [];

async function start(options: AppOptions = {}) {
  const provider = vi.fn<typeof fetch>();
  // Default mock refuses to access the network, including if a new route is added.
  provider.mockRejectedValue(
    new Error("Offline test: unexpected provider request"),
  );
  const server = createApp({
    config: configuration,
    fetch: provider,
    staticDir: false,
    ...options,
  }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (
    route: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(url + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  return { provider, url, post, server };
}

async function rawRequest(
  url: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  return new Promise<{ status: number; body: string; cacheControl?: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        url + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json", ...headers },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: text,
              cacheControl: response.headers["cache-control"],
            }),
          );
        },
      );
      request.once("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function responseJson(value: unknown) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
    { status: 200 },
  );
}

describe("Vercel host and origin policy", () => {
  const deploymentHost = "talksimul-test.vercel.app";
  const siteOrigin = "https://practice.example.com";
  const environment = {
    VERCEL: "1",
    VERCEL_URL: deploymentHost,
    TALK_SIMUL_SITE_ORIGIN: siteOrigin,
    OPENAI_API_KEY: configuration.apiKey,
    TALK_SIMUL_ENABLE_PAID_API: "true",
  };
  const requestBody = { config: session, messages };

  it("derives exact HTTPS origins from explicit Vercel configuration without changing local defaults", () => {
    const local = readConfig({
      VERCEL_URL: deploymentHost,
      TALK_SIMUL_SITE_ORIGIN: siteOrigin,
    });
    expect(local.runtime).toBe("local");
    expect(local.trustedOrigins).toEqual([]);
    const hosted = readConfig({
      ...environment,
      TALK_SIMUL_SITE_ORIGIN: `${siteOrigin}/`,
      VERCEL_BRANCH_URL: "talksimul-git-main.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "practice.example.com",
    });
    expect(hosted.runtime).toBe("vercel");
    expect(hosted.trustedOrigins).toEqual([
      siteOrigin,
      `https://${deploymentHost}`,
      "https://talksimul-git-main.vercel.app",
    ]);
    expect(readConfig({ VERCEL: "1" })).toMatchObject({
      runtime: "vercel",
      trustedOrigins: [],
      enabled: false,
      apiKey: "",
    });
    for (const invalid of [
      "http://practice.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://sub.localhost",
      "https://*.example.com",
      "https://user:password@practice.example.com",
      "https://practice.example.com:8443",
      "https://practice.example.com/path",
      "https://practice.example.com?x=1",
      "https://practice.example.com#part",
      "https://practice.example.com\\evil",
      "https://practice.example.com,https://evil.example",
      "null",
    ]) {
      expect(
        readConfig({ VERCEL: "1", TALK_SIMUL_SITE_ORIGIN: invalid })
          .trustedOrigins,
      ).toEqual([]);
    }
    for (const invalid of [
      "https://example.com",
      "example.com/",
      "example.com/path",
      "user@example.com",
      "*.vercel.app",
      "example.com:443",
    ]) {
      expect(
        readConfig({ VERCEL: "1", VERCEL_URL: invalid }).trustedOrigins,
      ).toEqual([]);
    }
  });

  it("serves configured deployment hosts and accepts JSON only from that same origin", async () => {
    const { provider, url } = await start({ config: readConfig(environment) });
    const hint = {
      text: "Could I have a latte?",
      meaning: "라테 한 잔 주세요.",
      note: "공손하게 주문하는 표현이에요.",
    };
    provider.mockImplementation(async () => responseJson(hint));
    for (const origin of [siteOrigin, `https://${deploymentHost}`]) {
      const host = new URL(origin).host;
      const status = await rawRequest(url, "/api/status", { Host: host });
      expect(status.status).toBe(200);
      expect(status.cacheControl).toBe("no-store");
      expect(status.body).not.toContain(configuration.apiKey);
      const result = await rawRequest(
        url,
        "/api/hint",
        {
          Host: host,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
        requestBody,
      );
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual(hint);
    }
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("rejects other origins, mismatched trusted hosts, and spoofed forwarding headers before provider access", async () => {
    const { provider, url } = await start({ config: readConfig(environment) });
    const ownOrigin = `https://${deploymentHost}`;
    for (const headers of [
      { Host: deploymentHost },
      { Host: deploymentHost, Origin: "null" },
      { Host: deploymentHost, Origin: `http://${deploymentHost}` },
      { Host: deploymentHost, Origin: `${ownOrigin}.evil.example` },
      { Host: deploymentHost, Origin: siteOrigin },
      {
        Host: deploymentHost,
        Origin: ownOrigin,
        "Sec-Fetch-Site": "same-site",
      },
      {
        Host: deploymentHost,
        Origin: ownOrigin,
        "Sec-Fetch-Site": "cross-site",
      },
      {
        Host: "evil.example",
        Origin: ownOrigin,
        "X-Forwarded-Host": deploymentHost,
        "X-Forwarded-Proto": "https",
        Forwarded: `host=${deploymentHost};proto=https`,
      },
      { Host: `${deploymentHost}.evil.example`, Origin: ownOrigin },
      { Host: "localhost:3001", Origin: "http://localhost:5188" },
    ] as Record<string, string>[]) {
      const response = await rawRequest(url, "/api/hint", headers, requestBody);
      expect(response.status).toBe(403);
      expect(response.cacheControl).toBe("no-store");
    }
    const wrongType = await rawRequest(
      url,
      "/api/hint",
      {
        Host: deploymentHost,
        Origin: ownOrigin,
        "Content-Type": "text/plain",
      },
      requestBody,
    );
    expect(wrongType.status).toBe(415);
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed on Vercel without any trusted origin even when paid API credentials are configured", async () => {
    const { provider, url } = await start({
      config: readConfig({
        VERCEL: "1",
        OPENAI_API_KEY: configuration.apiKey,
        TALK_SIMUL_ENABLE_PAID_API: "true",
      }),
    });
    const result = await rawRequest(
      url,
      "/api/hint",
      {
        Host: deploymentHost,
        Origin: `https://${deploymentHost}`,
      },
      requestBody,
    );
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).code).toBe("HOST_DENIED");
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps the paid API and key gates on trusted deployment origins", async () => {
    for (const [settings, code] of [
      [
        { ...environment, TALK_SIMUL_ENABLE_PAID_API: "false" },
        "PAID_API_DISABLED",
      ],
      [{ ...environment, OPENAI_API_KEY: "" }, "API_KEY_MISSING"],
    ] as const) {
      const { provider, url } = await start({ config: readConfig(settings) });
      for (const path of [
        "/api/hint",
        "/api/review",
        "/api/realtime",
        "/api/speech",
      ]) {
        const result = await rawRequest(
          url,
          path,
          {
            Host: deploymentHost,
            Origin: `https://${deploymentHost}`,
          },
          requestBody,
        );
        expect(result.status).toBe(503);
        expect(JSON.parse(result.body).code).toBe(code);
      }
      expect(provider).not.toHaveBeenCalled();
    }
  });

  it("keeps local host restrictions when deployment-looking variables are present outside Vercel", async () => {
    const { provider, url } = await start({
      config: readConfig({ ...environment, VERCEL: undefined }),
    });
    const result = await rawRequest(
      url,
      "/api/hint",
      {
        Host: deploymentHost,
        Origin: `https://${deploymentHost}`,
      },
      requestBody,
    );
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).code).toBe("LOCAL_ONLY");
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("pronunciation API", () => {
  it("returns MP3 data while keeping credentials server-side and language/level in the request", async () => {
    const { post, provider } = await start();
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0]);
    provider.mockResolvedValue(
      new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } }),
    );
    const response = await post("/api/speech", {
      config: { ...session, language: "ja" },
      text: "こんにちは。",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      audio: bytes.toString("base64"),
      mimeType: "audio/mpeg",
    });
    const [url, options] = provider.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    const payload = JSON.parse(options!.body as string);
    expect(payload).toMatchObject({
      model: "gpt-4o-mini-tts",
      input: "こんにちは。",
      voice: "marin",
      response_format: "mp3",
      speed: 0.85,
    });
    expect(payload.instructions).toContain("Japanese");
    expect(options!.body).not.toContain(configuration.apiKey);
  });

  it("rejects demo requests and empty or oversized pronunciation text before contacting the provider", async () => {
    const { post, provider } = await start();
    for (const body of [
      { config: { ...session, mode: "demo" }, text: "Hello" },
      { config: session, text: "   " },
      { config: session, text: "a".repeat(2001) },
    ]) {
      expect((await post("/api/speech", body)).status).toBe(400);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects non-audio, empty and oversized provider output without relaying its contents", async () => {
    const { post, provider } = await start();
    for (const response of [
      new Response(configuration.apiKey, {
        headers: { "Content-Type": "application/json" },
      }),
      new Response(new Uint8Array(), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
      new Response(new Uint8Array(2_000_001), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    ]) {
      provider.mockResolvedValueOnce(response);
      const result = await post("/api/speech", {
        config: session,
        text: "Hello",
      });
      expect(result.status).toBe(502);
      const body = await result.text();
      expect(body).toContain("PROVIDER_INVALID");
      expect(body).not.toContain(configuration.apiKey);
    }
  });
});

describe("local API privacy and permissions", () => {
  it("returns status without a credential or external request", async () => {
    const { url, provider } = await start();
    const response = await fetch(url + "/api/status");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      configured: true,
      enabled: true,
      realtimeModel: "gpt-realtime-2.1",
      textModel: "gpt-5.4-mini",
    });
    expect(body).not.toContain(configuration.apiKey);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...configuration, enabled: false }, "PAID_API_DISABLED"],
    [{ ...configuration, apiKey: "" }, "API_KEY_MISSING"],
  ])(
    "blocks external requests until key and explicit enable flag are both present",
    async (config, code) => {
      const { post, provider } = await start({ config });
      for (const route of [
        "/api/realtime",
        "/api/hint",
        "/api/review",
        "/api/speech",
      ]) {
        const response = await post(route, { sdp, config: session, messages });
        expect(response.status).toBe(503);
        expect((await response.json()).code).toBe(code);
      }
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it("requires the exact opt-in value and does not expose environment data", () => {
    expect(readConfig({}).textModel).toBe("gpt-6-luna");
    const config = readConfig({
      OPENAI_API_KEY: "secret",
      TALK_SIMUL_ENABLE_PAID_API: "TRUE",
      OPENAI_TEXT_MODEL: "bad/name",
    });
    expect(config.enabled).toBe(false);
    expect(config.textModel).toBe("gpt-6-luna");
  });

  it("rejects foreign origins, missing origins and rebinding hostnames before provider access", async () => {
    const { post, url, provider } = await start();
    expect(
      (
        await post(
          "/api/hint",
          { config: session, messages },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/hint", { config: session, messages }, { Origin: "" }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          "/api/hint",
          { config: session, messages },
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    // Node fetch normalizes Host, so exercise a raw HTTP Host header for rebinding protection.
    const rebindingStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          url + "/api/status",
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    expect(rebindingStatus).toBe(403);
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects duplicate ids, demo content, invalid enums and oversized text", async () => {
    const { post, provider } = await start();
    for (const body of [
      { config: session, messages: [messages[1], messages[1]] },
      { config: session, messages: [{ ...messages[1], source: "demo" }] },
      { config: { ...session, language: "fr" }, messages },
      { config: { ...session, mode: "demo" }, messages },
      {
        config: session,
        messages: [{ ...messages[1], text: "x".repeat(8001) }],
      },
    ])
      expect((await post("/api/review", body)).status).toBe(400);
    expect(
      (await post("/api/hint", { padding: "x".repeat(270000) })).status,
    ).toBe(413);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("provider contracts without live API usage", () => {
  it("keeps the key server-side and forwards the selected voice configuration as multipart", async () => {
    const { provider, post } = await start();
    provider.mockResolvedValue(new Response(sdp, { status: 201 }));
    const response = await post("/api/realtime", { config: session, sdp });
    expect(await response.json()).toEqual({ sdp });
    const [url, options] = provider.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${configuration.apiKey}`,
    );
    expect(options?.redirect).toBe("error");
    const form = options?.body as FormData;
    expect(form.get("sdp")).toBe(sdp);
    const setup = JSON.parse(String(form.get("session")));
    expect(setup.type).toBe("realtime");
    expect(setup.audio.input.transcription.language).toBe("en");
    expect(setup.audio.output.speed).toBe(0.8);
    expect(setup.instructions).toContain("small cafe");
    const japanese = realtimeSession(
      { ...session, language: "ja", level: "challenge", scenario: "hotel" },
      "voice",
      "transcribe",
    );
    expect(japanese.audio.input.transcription.language).toBe("ja");
    expect(japanese.audio.output.speed).toBe(1.05);
    expect(japanese.instructions).toContain("hotel receptionist");
    expect(japanese.instructions).toContain("Japanese");
  });

  it("requests contextual structured hints with store false and returns only validated fields", async () => {
    const { provider, post } = await start();
    const hint = {
      text: "Could I have a small latte?",
      meaning: "작은 라테 한 잔 주세요.",
      note: "Could I have로 공손하게 주문해요.",
    };
    provider.mockResolvedValue(responseJson(hint));
    expect(
      await (await post("/api/hint", { config: session, messages })).json(),
    ).toEqual(hint);
    const request = JSON.parse(String(provider.mock.calls[0][1]?.body));
    expect(request.store).toBe(false);
    expect(request.text.format.type).toBe("json_schema");
    expect(request.text.format.strict).toBe(true);
    expect(request.input[0].content).toHaveLength(3);
    expect(JSON.parse(request.input[0].content[1].text).transcript[1]).toEqual({
      id: "u1",
      role: "user",
      text: messages[1].text,
    });
  });

  it("returns insufficient evidence locally without sending an empty or short transcript", async () => {
    const { provider, post } = await start();
    for (const sample of [
      [],
      [messages[0]],
      [messages[1]],
      [
        { ...messages[1], text: "   ..." },
        { ...messages[2], text: "!" },
      ],
    ]) {
      const response = await post("/api/review", {
        config: session,
        messages: sample,
      });
      const result = await response.json();
      expect(result.insufficient).toBe(true);
      expect(result.feedback).toEqual([]);
      expect(result.assessment.grammar).toBe("평가할 발화가 부족해요");
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("accepts only corrections tied to actual user utterances", async () => {
    const { provider, post } = await start();
    provider.mockResolvedValue(responseJson(review));
    expect(
      await (await post("/api/review", { config: session, messages })).json(),
    ).toEqual(review);
    for (const feedback of [
      { ...review.feedback[0], messageId: "invented-id" },
      { ...review.feedback[0], messageId: "a1", original: messages[0].text },
      { ...review.feedback[0], original: "I goed to the park." },
      { ...review.feedback[0], category: "경어" },
    ]) {
      provider.mockResolvedValue(
        responseJson({ ...review, feedback: [feedback] }),
      );
      const response = await post("/api/review", { config: session, messages });
      expect(response.status).toBe(502);
      expect((await response.json()).code).toBe("UNGROUNDED_REVIEW");
    }
  });

  it("does not infer a full assessment from fabricated insufficient feedback", async () => {
    const { provider, post } = await start();
    provider.mockResolvedValue(
      responseJson({ ...review, insufficient: true, feedback: [] }),
    );
    const response = await post("/api/review", { config: session, messages });
    const body = await response.json();
    expect(body.insufficient).toBe(true);
    expect(body.assessment.delivery).toBe("평가할 발화가 부족해요");
  });

  it("omits unchanged corrections only after validating their original evidence", async () => {
    const { provider, post } = await start();
    const unchanged = {
      ...review.feedback[0],
      messageId: messages[1].id,
      original: messages[1].text,
      improved: messages[1].text,
      explanation: "현재 문장은 자연스럽게 뜻을 전달해요.",
      category: "자연스러움",
    };
    for (const corrections of [[unchanged, ...review.feedback], [unchanged]]) {
      provider.mockResolvedValueOnce(
        responseJson({ ...review, feedback: corrections }),
      );
      const response = await post("/api/review", { config: session, messages });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.insufficient).toBe(false);
      expect(result.feedback).toEqual(
        corrections.length === 1 ? [] : review.feedback,
      );
    }
    provider.mockResolvedValueOnce(
      responseJson({
        ...review,
        feedback: [{ ...unchanged, messageId: "invented-id" }],
      }),
    );
    const response = await post("/api/review", { config: session, messages });
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("UNGROUNDED_REVIEW");
  });

  it.each([
    "自然な表現です。",
    "自然な表現です。申し訳ありません。以上です。가",
    "「自然な表現です。申し訳ありません。以上です。」가",
    "Both sentences are natural. Thank you for your practice.가",
    "自然な表現です。申し訳ありません。以上です。".repeat(6) + "괜찮아요.",
  ])(
    "rejects foreign explanations even when padded with Korean: %s",
    async (untranslated) => {
      const { provider, post } = await start();
      const invalidReviews = [
        { ...review, summary: untranslated },
        {
          ...review,
          feedback: [{ ...review.feedback[0], explanation: untranslated }],
        },
        {
          ...review,
          assessment: Object.fromEntries(
            Object.keys(review.assessment).map((field) => [
              field,
              untranslated,
            ]),
          ),
        },
        ...Object.keys(review.assessment).map((field) => ({
          ...review,
          assessment: { ...review.assessment, [field]: untranslated },
        })),
      ];
      for (const invalid of invalidReviews) {
        provider.mockResolvedValueOnce(responseJson(invalid));
        const response = await post("/api/review", {
          config: session,
          messages,
        });
        expect(response.status).toBe(502);
        expect((await response.json()).code).toBe("PROVIDER_INVALID");
      }
      const hint = {
        text: "ホットでお願いします。",
        meaning: "따뜻한 것으로 주세요.",
        note: "온도를 선택할 때 쓰는 표현이에요.",
      };
      for (const field of ["meaning", "note"]) {
        provider.mockResolvedValueOnce(
          responseJson({ ...hint, [field]: untranslated }),
        );
        const response = await post("/api/hint", {
          config: { ...session, language: "ja" },
          messages,
        });
        expect(response.status).toBe(502);
        expect((await response.json()).code).toBe("PROVIDER_INVALID");
      }
    },
  );

  it("preserves Japanese examples and corrections while requiring Korean explanation fields in both schemas", async () => {
    const { provider, post } = await start();
    const japanese = [
      { ...messages[1], text: "ホットのカフェラテを一つお願いします。" },
      { ...messages[2], text: "昨日、友達とカフェに行きました。" },
    ];
    const config = { ...session, language: "ja" };
    const correction = {
      ...review,
      feedback: [
        {
          messageId: japanese[0].id,
          original: japanese[0].text,
          improved: "ホットのカフェラテを1杯お願いします。",
          explanation:
            "「ホットのカフェラテを1杯お願いします。」는 같은 뜻의 선택 표현이에요.",
          category: "어휘",
        },
      ],
    };
    provider.mockResolvedValueOnce(responseJson(correction));
    const response = await post("/api/review", { config, messages: japanese });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(correction);
    const reviewRequest = JSON.parse(String(provider.mock.calls[0][1]?.body));
    const reviewProperties = reviewRequest.text.format.schema.properties;
    expect(reviewProperties.summary.pattern).toBe("[가-힣]");
    const feedbackProperties = reviewProperties.feedback.items.properties;
    expect(feedbackProperties.explanation.pattern).toBe("[가-힣]");
    expect(feedbackProperties.original.pattern).toBeUndefined();
    expect(feedbackProperties.improved.pattern).toBeUndefined();
    for (const field of Object.keys(review.assessment)) {
      expect(reviewProperties.assessment.properties[field].pattern).toBe(
        "[가-힣]",
      );
    }
    const hint = {
      text: "ホットでお願いします。",
      meaning: "따뜻한 것으로 주세요.",
      note: "온도를 선택할 때 쓰는 표현이에요.",
    };
    provider.mockResolvedValueOnce(responseJson(hint));
    const hintResponse = await post("/api/hint", {
      config,
      messages: japanese,
    });
    expect(hintResponse.status).toBe(200);
    expect(await hintResponse.json()).toEqual(hint);
    const hintRequest = JSON.parse(String(provider.mock.calls[1][1]?.body));
    const hintProperties = hintRequest.text.format.schema.properties;
    expect(hintProperties.meaning.pattern).toBe("[가-힣]");
    expect(hintProperties.note.pattern).toBe("[가-힣]");
    expect(hintProperties.text.pattern).toBeUndefined();
  });

  it("accepts Korean explanations with English quotations and short Korean hint translations", async () => {
    const { provider, post } = await start();
    const correction = {
      ...review,
      summary: '"I go to park yesterday."는 과거형을 고쳐요.',
      feedback: [
        {
          ...review.feedback[0],
          explanation:
            '"I went to the park yesterday."는 같은 뜻의 교정이에요.',
        },
      ],
    };
    provider.mockResolvedValueOnce(responseJson(correction));
    const response = await post("/api/review", { config: session, messages });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(correction);

    for (const hint of [
      {
        text: "Could I have a small hot latte to go, please?",
        meaning: "따뜻한 작은 라테를 포장해 주시겠어요?",
        note: "“Could I have a small hot latte to go, please?”는 주문할 때 써요.",
      },
      {
        text: "Yes, please.",
        meaning: "네.",
        note: "정중하게 동의해요.",
      },
    ]) {
      provider.mockResolvedValueOnce(responseJson(hint));
      const hintResponse = await post("/api/hint", {
        config: session,
        messages,
      });
      expect(hintResponse.status).toBe(200);
      expect(await hintResponse.json()).toEqual(hint);
    }
  });

  it("supports Japanese evidence without English word-count assumptions", () => {
    const japanese: Message[] = [
      { ...messages[1], text: "コーヒーをください。" },
      { ...messages[2], text: "持ち帰りでお願いします。" },
    ];
    expect(hasEnoughEvidence(japanese, "ja")).toBe(true);
    expect(
      isGroundedReview(
        {
          ...review,
          feedback: [
            {
              ...review.feedback[0],
              original: japanese[1].text,
              category: "敬語",
            },
          ],
        },
        japanese,
        "ja",
      ),
    ).toBe(false);
    expect(
      isGroundedReview(
        {
          ...review,
          feedback: [
            {
              ...review.feedback[0],
              original: japanese[1].text,
              category: "경어",
            },
          ],
        },
        japanese,
        "ja",
      ),
    ).toBe(true);
  });

  it("sanitizes provider errors and incomplete structured output", async () => {
    const { provider, post } = await start();
    provider.mockResolvedValue(
      new Response(
        JSON.stringify({ key: configuration.apiKey, transcript: messages }),
        { status: 401 },
      ),
    );
    const failure = await post("/api/hint", { config: session, messages });
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain(configuration.apiKey);
    provider.mockResolvedValue(
      new Response(JSON.stringify({ status: "incomplete", output: [] })),
    );
    const incomplete = await post("/api/hint", { config: session, messages });
    expect((await incomplete.json()).code).toBe("PROVIDER_INVALID");
  });

  it("times out without exposing internal exception details", async () => {
    const provider = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error(configuration.apiKey)),
            { once: true },
          );
        }),
    );
    const { post } = await start({ fetch: provider, timeoutMs: 20 });
    const result = await post("/api/hint", { config: session, messages });
    expect(result.status).toBe(504);
    const body = await result.text();
    expect(body).toContain("PROVIDER_TIMEOUT");
    expect(body).not.toContain(configuration.apiKey);
  });

  it("aborts provider work and releases request slots when Vercel reports a request error before response close", async () => {
    let incoming: IncomingMessage | undefined;
    let started: () => void = () => {};
    let signal: AbortSignal | undefined;
    const provider = vi
      .fn<typeof fetch>()
      .mockImplementation((_url, options) => {
        signal = options?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error(configuration.apiKey)),
            { once: true },
          );
          started();
        });
      });
    const { server, post } = await start({ fetch: provider, timeoutMs: 10000 });
    server.on("request", (request) => {
      incoming = request;
    });
    // More than the three concurrent slots proves each cancelled call releases its slot.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const providerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = post("/api/hint", { config: session, messages });
      await providerStarted;
      expect(signal?.aborted).toBe(false);
      incoming!.emit("error", new Error("aborted"));
      expect(signal?.aborted).toBe(true);
      const response = await pending;
      expect(await response.text()).toBe("");
      expect(response.status).not.toBe(429);
      expect(incoming!.listenerCount("error")).toBe(0);
    }
    expect(provider).toHaveBeenCalledTimes(4);
  });
});
