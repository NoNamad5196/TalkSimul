import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hint, Message, Review } from "../shared/types.js";
import { publicStatus, readConfig, type ServerConfig } from "./config.js";
import {
  hasEnoughEvidence,
  hintInstructions,
  insufficientReview,
  isGroundedReview,
  realtimeSession,
  reviewInstructions,
} from "./prompts.js";
import {
  conversationSchema,
  hintJsonSchema,
  hintSchema,
  realtimeSchema,
  reviewJsonSchema,
  reviewSchema,
  speechSchema,
} from "./validation.js";

const LOCAL_ORIGINS = new Set(
  ["127.0.0.1", "localhost"].flatMap((host) =>
    [3001, 5188, 4173].map((port) => `http://${host}:${port}`),
  ),
);
const API_BASE = "https://api.openai.com/v1";

class ApiFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiFailure(
  res: Response,
  code: string,
  status: number,
  error: string,
) {
  res.status(status).json({ error, code });
}

export interface AppOptions {
  config?: ServerConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  staticDir?: string | false;
}

// Dependency injection keeps every automated API test offline.
export function createApp(options: AppOptions = {}) {
  const config = options.config ?? readConfig();
  const hosted = config.runtime === "vercel";
  const trustedOrigins = new Set(config.trustedOrigins);
  const requestProvider = options.fetch ?? fetch;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    const host = (req.headers.host ?? "").toLowerCase();
    const requestOrigin = `https://${host}`;
    const trustedHost = hosted
      ? trustedOrigins.has(requestOrigin)
      : /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host);
    if (!trustedHost) {
      apiFailure(
        res,
        hosted ? "HOST_DENIED" : "LOCAL_ONLY",
        403,
        hosted
          ? "허용된 앱 주소로 다시 접속해 주세요. 서버의 배포 주소 설정을 확인해 주세요."
          : "이 앱은 이 기기의 로컬 주소에서만 사용할 수 있어요.",
      );
      return;
    }
    if (req.method === "POST" && req.path.startsWith("/api")) {
      const origin = req.headers.origin ?? "";
      const fetchSite = req.headers["sec-fetch-site"];
      const trustedOrigin = hosted
        ? trustedOrigins.has(origin) && origin === requestOrigin
        : LOCAL_ORIGINS.has(origin);
      if (
        !trustedOrigin ||
        fetchSite === "cross-site" ||
        (hosted && fetchSite !== undefined && fetchSite !== "same-origin")
      ) {
        apiFailure(
          res,
          "ORIGIN_DENIED",
          403,
          "허용되지 않은 요청이에요. 접속한 앱 화면에서 다시 시작해 주세요.",
        );
        return;
      }
      if (!req.is("application/json")) {
        apiFailure(
          res,
          "INVALID_CONTENT_TYPE",
          415,
          "JSON 형식의 요청이 필요해요.",
        );
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));

  app.get("/api/status", (_req, res) => res.json(publicStatus(config)));

  let inFlight = 0;
  let windowStart = Date.now();
  let callsInWindow = 0;
  app.use("/api", (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    if (!config.enabled) {
      apiFailure(
        res,
        "PAID_API_DISABLED",
        503,
        "실제 AI 연결은 아직 꺼져 있어요. 서버의 비용·외부 전송 승인 설정을 확인해 주세요.",
      );
      return;
    }
    if (!config.apiKey) {
      apiFailure(
        res,
        "API_KEY_MISSING",
        503,
        "서버의 API 키가 설정되지 않았어요. 키는 서버의 비공개 환경 설정에 입력해 주세요.",
      );
      return;
    }
    const now = Date.now();
    if (now - windowStart >= 60000) {
      windowStart = now;
      callsInWindow = 0;
    }
    if (callsInWindow >= 30 || inFlight >= 3) {
      res.set("Retry-After", "10");
      apiFailure(
        res,
        "TOO_MANY_REQUESTS",
        429,
        "요청이 잠깐 몰렸어요. 잠시 뒤 다시 시도해 주세요.",
      );
      return;
    }
    callsInWindow += 1;
    inFlight += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight -= 1;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });

  async function providerRequest(
    path: string,
    body: BodyInit,
    res: Response,
    contentType?: string,
    audioResponse = false,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 45000,
    );
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    // Vercel supportsCancellation reports a cancelled client request as req.error.
    const onRequestError = () => {
      controller.abort();
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    res.once("close", onClose);
    res.req.on("error", onRequestError);
    try {
      const upstream = await requestProvider(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (!upstream.ok) {
        // Upstream bodies may echo submitted text or details about credentials. Never relay or log them.
        await upstream.body?.cancel();
        if (upstream.status === 401 || upstream.status === 403)
          throw new ApiFailure(
            "PROVIDER_ACCESS",
            502,
            "AI 서비스 인증 또는 모델 접근을 확인해 주세요. 키는 서버의 비공개 환경 설정에서 확인할 수 있어요.",
          );
        if (upstream.status === 429)
          throw new ApiFailure(
            "PROVIDER_LIMIT",
            429,
            "AI 서비스의 사용량 또는 요청 한도에 도달했어요. 계정 한도를 확인하고 다시 시도해 주세요.",
          );
        throw new ApiFailure(
          "PROVIDER_FAILED",
          502,
          "AI 서비스 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.",
        );
      }
      if (audioResponse) {
        if (
          !/^audio\/(mpeg|mp3)(?:;|$)/i.test(
            upstream.headers.get("content-type") ?? "",
          )
        ) {
          await upstream.body?.cancel();
          throw new ApiFailure(
            "PROVIDER_INVALID",
            502,
            "발음 오디오 응답을 확인하지 못했어요.",
          );
        }
        const bytes = await upstream.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > 2_000_000)
          throw new ApiFailure(
            "PROVIDER_INVALID",
            502,
            "발음 오디오의 길이를 확인하지 못했어요.",
          );
        return Buffer.from(bytes).toString("base64");
      }
      const text = await upstream.text();
      if (text.length > 256000)
        throw new ApiFailure(
          "PROVIDER_INVALID",
          502,
          "AI 응답이 너무 길어 처리하지 못했어요.",
        );
      return text;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (controller.signal.aborted)
        throw new ApiFailure(
          "PROVIDER_TIMEOUT",
          504,
          "AI 연결 시간이 초과되었어요. 네트워크를 확인한 뒤 다시 시도해 주세요.",
        );
      throw new ApiFailure(
        "PROVIDER_UNAVAILABLE",
        502,
        "AI 서비스에 연결할 수 없어요. 네트워크와 서버 설정을 확인해 주세요.",
      );
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", onClose);
      res.req.removeListener("error", onRequestError);
    }
  }

  async function structuredResponse(
    name: string,
    schema: object,
    instructions: string,
    messages: Message[],
    res: Response,
  ): Promise<unknown> {
    const raw = await providerRequest(
      "/responses",
      JSON.stringify({
        model: config.textModel,
        store: false,
        instructions,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  transcript: messages.map(({ id, role, text }) => ({
                    id,
                    role,
                    text,
                  })),
                }),
              },
            ],
          },
        ],
        max_output_tokens: name === "conversation_hint" ? 1600 : 5000,
        reasoning: { effort: "low" },
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
      res,
      "application/json",
    );
    try {
      const response = JSON.parse(raw) as {
        status?: string;
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };
      if (response.status !== "completed" || !Array.isArray(response.output))
        throw new Error("Incomplete response");
      const text = response.output
        .flatMap((item) =>
          item.type === "message" && Array.isArray(item.content)
            ? item.content
            : [],
        )
        .filter(
          (content) =>
            content.type === "output_text" && typeof content.text === "string",
        )
        .map((content) => content.text)
        .join("");
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiFailure(
        "PROVIDER_INVALID",
        502,
        "AI 응답 형식을 확인하지 못했어요. 다시 시도해 주세요.",
      );
    }
  }

  app.post("/api/realtime", async (req, res) => {
    const parsed = realtimeSchema.safeParse(req.body);
    if (!parsed.success) {
      apiFailure(
        res,
        "INVALID_REQUEST",
        400,
        "대화 연결 설정을 확인해 주세요.",
      );
      return;
    }
    const form = new FormData();
    form.set("sdp", parsed.data.sdp);
    form.set(
      "session",
      JSON.stringify(
        realtimeSession(
          parsed.data.config,
          config.realtimeModel,
          config.transcriptionModel,
        ),
      ),
    );
    const answer = await providerRequest("/realtime/calls", form, res);
    if (!answer.startsWith("v=0") || !/(?:^|\r?\n)m=audio /.test(answer))
      throw new ApiFailure(
        "PROVIDER_INVALID",
        502,
        "AI 음성 연결 응답을 확인하지 못했어요.",
      );
    if (!res.destroyed) res.json({ sdp: answer });
  });

  app.post("/api/hint", async (req, res) => {
    const parsed = conversationSchema.safeParse(req.body);
    if (!parsed.success) {
      apiFailure(
        res,
        "INVALID_REQUEST",
        400,
        "대화 내용이 너무 길거나 올바르지 않아요. 새 대화에서 다시 시도해 주세요.",
      );
      return;
    }
    const raw = await structuredResponse(
      "conversation_hint",
      hintJsonSchema,
      hintInstructions(parsed.data.config),
      parsed.data.messages.slice(-20),
      res,
    );
    const hint = hintSchema.safeParse(raw);
    if (!hint.success)
      throw new ApiFailure(
        "PROVIDER_INVALID",
        502,
        "표현 도움 응답을 확인하지 못했어요. 다시 시도해 주세요.",
      );
    if (!res.destroyed) res.json(hint.data satisfies Hint);
  });

  app.post("/api/speech", async (req, res) => {
    const parsed = speechSchema.safeParse(req.body);
    if (!parsed.success) {
      apiFailure(
        res,
        "INVALID_REQUEST",
        400,
        "발음 문장은 2,000자 이하로 입력해 주세요. 실제 모드에서 사용할 수 있어요.",
      );
      return;
    }
    const { config: session, text } = parsed.data;
    const audio = await providerRequest(
      "/audio/speech",
      JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "marin",
        input: text,
        instructions: `Read the supplied text exactly in ${session.language === "en" ? "English" : "Japanese"}. Use a warm, clear voice for a language learner. Do not translate or add words.`,
        response_format: "mp3",
        speed:
          session.level === "beginner"
            ? 0.85
            : session.level === "basic"
              ? 0.95
              : 1,
      }),
      res,
      "application/json",
      true,
    );
    if (!res.destroyed) res.json({ audio, mimeType: "audio/mpeg" });
  });

  app.post("/api/review", async (req, res) => {
    const parsed = conversationSchema.safeParse(req.body);
    if (!parsed.success) {
      apiFailure(
        res,
        "INVALID_REQUEST",
        400,
        "복기할 대화 내용이 너무 길거나 올바르지 않아요.",
      );
      return;
    }
    const { config: session, messages } = parsed.data;
    if (!hasEnoughEvidence(messages, session.language)) {
      res.json(insufficientReview());
      return;
    }
    const raw = await structuredResponse(
      "conversation_review",
      reviewJsonSchema,
      reviewInstructions(session),
      messages,
      res,
    );
    const review = reviewSchema.safeParse(raw);
    if (!review.success) {
      throw new ApiFailure(
        "PROVIDER_INVALID",
        502,
        "복기 형식이나 한국어 설명을 확인하지 못했어요. 발화 기록은 남아 있으니 다시 시도해 주세요.",
      );
    }
    if (!isGroundedReview(review.data, messages, session.language)) {
      throw new ApiFailure(
        "UNGROUNDED_REVIEW",
        502,
        "실제 발화와 일치하는 복기인지 확인하지 못했어요. 발화 기록은 그대로 남아 있으니 다시 시도해 주세요.",
      );
    }
    const result: Review = review.data.insufficient
      ? insufficientReview()
      : review.data;
    if (!res.destroyed) res.json(result);
  });

  app.use("/api", (_req, res) =>
    apiFailure(res, "NOT_FOUND", 404, "요청한 기능을 찾을 수 없어요."),
  );

  const staticDir =
    options.staticDir === undefined
      ? fileURLToPath(new URL("../dist", import.meta.url))
      : options.staticDir;
  if (staticDir && existsSync(resolve(staticDir, "index.html"))) {
    app.use(express.static(staticDir, { dotfiles: "deny", index: false }));
    app.use((req: Request, res: Response, next) => {
      if (req.method === "GET" && req.accepts("html"))
        res.sendFile(resolve(staticDir, "index.html"));
      else next();
    });
  }

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof ApiFailure) {
      apiFailure(res, error.code, error.status, error.message);
      return;
    }
    const parsingError = error as { type?: string };
    if (parsingError?.type === "entity.too.large") {
      apiFailure(
        res,
        "PAYLOAD_TOO_LARGE",
        413,
        "대화 내용이 너무 길어요. 새 대화에서 다시 시작해 주세요.",
      );
      return;
    }
    if (parsingError?.type === "entity.parse.failed") {
      apiFailure(res, "INVALID_JSON", 400, "요청 형식을 확인해 주세요.");
      return;
    }
    apiFailure(
      res,
      "INTERNAL_ERROR",
      500,
      "요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
    );
  };
  app.use(errorHandler);
  return app;
}
