import type { ApiStatus } from "../shared/types.js";

export interface ServerConfig {
  apiKey: string;
  enabled: boolean;
  realtimeModel: string;
  textModel: string;
  transcriptionModel: string;
  runtime: "local" | "vercel";
  trustedOrigins: string[];
}

const modelName = (value: string | undefined, fallback: string) =>
  value && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : fallback;

function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    const hostname = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        hostname,
      ) ||
      hostname.endsWith(".localhost") ||
      (candidate !== url.origin && candidate !== `${url.origin}/`)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runtime = env.VERCEL === "1" ? "vercel" : "local";
  // These values come only from server configuration, never forwarded request headers.
  const trustedOrigins =
    runtime === "vercel"
      ? [
          httpsOrigin(env.TALK_SIMUL_SITE_ORIGIN),
          ...[
            env.VERCEL_URL,
            env.VERCEL_BRANCH_URL,
            env.VERCEL_PROJECT_PRODUCTION_URL,
          ].map((hostname) =>
            hostname && !/[\s\\/:?#@]/.test(hostname)
              ? httpsOrigin(`https://${hostname}`)
              : null,
          ),
        ].filter((origin): origin is string => origin !== null)
      : [];
  return {
    apiKey: env.OPENAI_API_KEY?.trim() ?? "",
    enabled: env.TALK_SIMUL_ENABLE_PAID_API === "true",
    realtimeModel: modelName(env.OPENAI_REALTIME_MODEL, "gpt-realtime-2.1"),
    textModel: modelName(env.OPENAI_TEXT_MODEL, "gpt-5.4-mini"),
    transcriptionModel: modelName(
      env.OPENAI_TRANSCRIPTION_MODEL,
      "gpt-4o-mini-transcribe",
    ),
    runtime,
    trustedOrigins: [...new Set(trustedOrigins)],
  };
}

export function publicStatus(config: ServerConfig): ApiStatus {
  return {
    configured: Boolean(config.apiKey),
    enabled: config.enabled,
    realtimeModel: config.realtimeModel,
    textModel: config.textModel,
  };
}
