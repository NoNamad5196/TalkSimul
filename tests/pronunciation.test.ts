import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../shared/types";
import { speakPronunciation, stopSpeech } from "../src/lib/audio";

class MockUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: SpeechSynthesisErrorCode }) => void) | null = null;
  constructor(public text: string) {}
}

class MockAudio {
  static instances: MockAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  play = vi.fn(() => MockAudio.playResult());
  constructor() {
    MockAudio.instances.push(this);
  }
}

const live: SessionConfig = {
  language: "en",
  level: "basic",
  scenario: "cafe",
  mode: "live",
};
const localVoice = {
  name: "Device English",
  lang: "en-US",
  localService: true,
};
const speechResponse = () =>
  new Response(JSON.stringify({ audio: "SUQz", mimeType: "audio/mpeg" }), {
    status: 200,
  });
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

describe("pronunciation local-first and authorized server fallback (mocked)", () => {
  let synthesis: {
    getVoices: ReturnType<typeof vi.fn>;
    speak: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  let request: ReturnType<typeof vi.fn>;
  let createUrl: ReturnType<typeof vi.fn>;
  let revokeUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    synthesis = { getVoices: vi.fn(() => []), speak: vi.fn(), cancel: vi.fn() };
    request = vi.fn().mockImplementation(async () => speechResponse());
    createUrl = vi.fn().mockReturnValue("blob:pronunciation-1");
    revokeUrl = vi.fn();
    MockAudio.instances = [];
    MockAudio.playResult = () => Promise.resolve();
    vi.stubGlobal("window", { speechSynthesis: synthesis });
    vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("URL", {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    });
  });
  afterEach(() => {
    stopSpeech();
    vi.unstubAllGlobals();
  });

  it("keeps successful live playback on a local voice and completes only once", () => {
    synthesis.getVoices.mockReturnValue([localVoice]);
    const end = vi.fn();
    speakPronunciation("A latte, please.", live, end);
    const utterance = synthesis.speak.mock.calls[0][0] as MockUtterance;
    const queuedEnd = utterance.onend;
    utterance.onend?.();
    queuedEnd?.();
    expect(end).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(MockAudio.instances).toHaveLength(0);
  });

  it("does not transmit demo text when the local voice is absent", async () => {
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation(
      "Private demo phrase",
      { ...live, mode: "demo" },
      end,
      notice,
    );
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith(
      expect.stringContaining("영어 기기 음성이 없어요"),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not transmit demo text when an installed local voice fails asynchronously", async () => {
    synthesis.getVoices.mockReturnValue([localVoice]);
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation(
      "Private demo phrase",
      { ...live, mode: "demo" },
      end,
      notice,
    );
    const utterance = synthesis.speak.mock.calls[0][0] as MockUtterance;
    utterance.onerror?.({ error: "synthesis-failed" });
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith(
      expect.stringContaining("기기 음성 재생에 실패"),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("fetches the selected live phrase, reports loading, and frees media only when playback ends", async () => {
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation("A latte, please.", live, end, notice);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("준비하고 있어요"),
    );
    await settle();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("/api/speech");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      config: live,
      text: "A latte, please.",
    });
    const audio = MockAudio.instances[0];
    expect(audio.src).toBe("blob:pronunciation-1");
    expect(audio.play).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("발음을 듣고 있어요.");
    const queuedEnd = audio.onended;
    audio.onended?.();
    queuedEnd?.();
    expect(end).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:pronunciation-1");
    expect(notice).toHaveBeenLastCalledWith("");
  });

  it("waits for fallback completion after an asynchronous local error without an early or double resume", async () => {
    synthesis.getVoices.mockReturnValue([localVoice]);
    const end = vi.fn();
    speakPronunciation("A latte, please.", live, end);
    const utterance = synthesis.speak.mock.calls[0][0] as MockUtterance;
    const staleError = utterance.onerror,
      staleEnd = utterance.onend;
    utterance.onerror?.({ error: "synthesis-failed" });
    staleError?.({ error: "synthesis-failed" });
    staleEnd?.();
    expect(end).not.toHaveBeenCalled();
    await settle();
    expect(request).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    MockAudio.instances[0].onended?.();
    expect(end).toHaveBeenCalledOnce();
  });

  it("aborts pending speech generation on close and ignores a late successful response without resuming", async () => {
    let resolveRequest!: (value: Response) => void;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation("A phrase", live, end, notice);
    const signal = request.mock.calls[0][1].signal as AbortSignal;
    stopSpeech();
    const noticeCount = notice.mock.calls.length;
    expect(signal.aborted).toBe(true);
    resolveRequest(speechResponse());
    await settle();
    expect(createUrl).not.toHaveBeenCalled();
    expect(MockAudio.instances).toHaveLength(0);
    expect(end).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(noticeCount);
  });

  it("cancels old audio before starting another phrase and blocks its queued callbacks", async () => {
    const oldEnd = vi.fn(),
      oldNotice = vi.fn(),
      newEnd = vi.fn();
    speakPronunciation("First phrase", live, oldEnd, oldNotice);
    await settle();
    const oldAudio = MockAudio.instances[0];
    const queuedEnd = oldAudio.onended,
      queuedError = oldAudio.onerror;
    speakPronunciation("Second phrase", live, newEnd);
    expect(oldAudio.pause).toHaveBeenCalledOnce();
    expect(oldAudio.src).toBe("");
    expect(revokeUrl).toHaveBeenCalledOnce();
    const noticeCount = oldNotice.mock.calls.length;
    queuedEnd?.();
    queuedError?.();
    await settle();
    expect(oldEnd).not.toHaveBeenCalled();
    expect(oldNotice).toHaveBeenCalledTimes(noticeCount);
    expect(newEnd).not.toHaveBeenCalled();
    MockAudio.instances[1].onended?.();
    expect(newEnd).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight play promise and discards its later rejection", async () => {
    let rejectPlay!: (reason: unknown) => void;
    MockAudio.playResult = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPlay = reject;
      });
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation("A phrase", live, end, notice);
    await settle();
    stopSpeech();
    const noticeCount = notice.mock.calls.length;
    rejectPlay(new Error("old play request canceled"));
    await settle();
    expect(end).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(noticeCount);
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it.each([
    "network",
    "server-disabled",
    "invalid-response",
    "play-rejected",
    "media-error",
  ])("reports %s safely and completes once", async (failure) => {
    if (failure === "network")
      request.mockRejectedValue(new Error("private transport details"));
    if (failure === "server-disabled")
      request.mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: "private server details" }), {
            status: 403,
          }),
      );
    if (failure === "invalid-response")
      request.mockImplementation(
        async () =>
          new Response(JSON.stringify({ audio: "", mimeType: "text/plain" })),
      );
    if (failure === "play-rejected")
      MockAudio.playResult = () =>
        Promise.reject(new Error("private playback details"));
    const end = vi.fn(),
      notice = vi.fn();
    speakPronunciation("A phrase", live, end, notice);
    await settle();
    if (failure === "media-error") {
      const audio = MockAudio.instances[0];
      const queuedError = audio.onerror;
      audio.onerror?.();
      queuedError?.();
    }
    expect(end).toHaveBeenCalledOnce();
    expect(notice.mock.calls.at(-1)?.[0]).toMatch(/못했어요|실패했어요/);
    expect(notice.mock.calls.at(-1)?.[0]).not.toContain("private");
    expect(revokeUrl).toHaveBeenCalledTimes(MockAudio.instances.length);
    stopSpeech();
    expect(end).toHaveBeenCalledOnce();
  });
});
