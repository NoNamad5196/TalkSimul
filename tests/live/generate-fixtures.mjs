/**
 * Opt-in synthetic audio fixtures for a small, explicitly approved live test.
 * Run: node tests/live/generate-fixtures.mjs --generate
 * Four requests on a successful run, no retries, no microphone input.
 * Official docs checked 2026-10-09:
 * https://developers.openai.com/api/docs/guides/text-to-speech
 * https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
 */
import dotenv from "dotenv";
import { mkdir, access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../..");
const outputDirectory = resolve(scriptDirectory, "fixtures");
const endpoint = "https://api.openai.com/v1/audio/speech";
const fixtures = [
  {
    name: "en-1.wav",
    input: "I would like a small hot latte, please.",
    language: "English",
  },
  {
    name: "en-2.wav",
    input: "I went to a cafe with my friend yesterday.",
    language: "English",
  },
  {
    name: "ja-1.wav",
    input: "ホットのカフェラテを一つお願いします。",
    language: "Japanese",
  },
  {
    name: "ja-2.wav",
    input: "昨日、友達とカフェに行きました。",
    language: "Japanese",
  },
];
const knownProviderCodes = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "invalid_request_error",
  "permission_denied",
  "server_error",
  "service_unavailable",
  "unsupported_value",
]);

class SafeFailure extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readBounded(response, maximumBytes) {
  if (!response.body) throw new SafeFailure("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new SafeFailure("RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function waveMetadata(bytes) {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new SafeFailure("INVALID_WAVE");
  }
  let format;
  let dataLength;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === "fmt " && length >= 16 && start + 16 <= bytes.length) {
      format = {
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    }
    if (kind === "data") {
      dataLength = Math.min(length, bytes.length - start);
      break;
    }
    offset = start + length + (length % 2);
  }
  if (!format?.byteRate || !dataLength) throw new SafeFailure("INVALID_WAVE");
  return {
    bytes: bytes.length,
    seconds: Number((dataLength / format.byteRate).toFixed(3)),
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
  };
}

async function main() {
  if (!process.argv.includes("--generate"))
    throw new SafeFailure("OPT_IN_REQUIRED");

  // Read only this project's dotenv file at runtime. Never serialize its contents.
  // This object is never sent as a payload; only apiKey is used in Authorization.
  const localEnvironment = {};
  dotenv.config({
    path: resolve(projectDirectory, ".env"),
    processEnv: localEnvironment,
    quiet: true,
  });
  const apiKey = localEnvironment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new SafeFailure("API_KEY_MISSING");
  if (localEnvironment.TALK_SIMUL_ENABLE_PAID_API !== "true")
    throw new SafeFailure("PAID_API_DISABLED");

  // Refuse to overwrite or regenerate any existing fixture, including a partial run.
  for (const fixture of fixtures) {
    try {
      await access(resolve(outputDirectory, fixture.name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new SafeFailure("OUTPUT_ACCESS_FAILED");
    }
    throw new SafeFailure("FIXTURE_EXISTS");
  }
  await mkdir(outputDirectory, { recursive: true });
  let attempts = 0;
  for (const fixture of fixtures) {
    attempts += 1;
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: "coral",
          response_format: "wav",
          input: fixture.input,
          instructions: `Speak the supplied ${fixture.language} sentence clearly at a relaxed conversational pace. Say only the supplied sentence.`,
        }),
      });
    } catch (error) {
      throw new SafeFailure(
        error?.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "NETWORK_FAILURE",
      );
    }
    if (!response.ok) {
      let code = "PROVIDER_ERROR";
      try {
        const payload = JSON.parse(
          (await readBounded(response, 16384)).toString("utf8"),
        );
        if (knownProviderCodes.has(payload?.error?.code))
          code = payload.error.code;
      } catch {
        /* Never output provider text, input, or credential details. */
      }
      throw new SafeFailure(code, response.status);
    }
    let bytes;
    try {
      bytes = await readBounded(response, 4 * 1024 * 1024);
    } catch (error) {
      if (error instanceof SafeFailure) throw error;
      throw new SafeFailure(
        error?.name === "TimeoutError"
          ? "REQUEST_TIMEOUT"
          : "AUDIO_READ_FAILED",
      );
    }
    const metadata = waveMetadata(bytes);
    await writeFile(resolve(outputDirectory, fixture.name), bytes, {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        file: `tests/live/fixtures/${fixture.name}`,
        ...metadata,
      }),
    );
  }
  console.log(
    JSON.stringify({ generated: fixtures.length, requests: attempts }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      code:
        error instanceof SafeFailure ? error.code : "LOCAL_OPERATION_FAILED",
      ...(error instanceof SafeFailure && error.status
        ? { status: error.status }
        : {}),
    }),
  );
  process.exitCode = 1;
});
