import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakLocal, stopSpeech } from "../src/lib/audio";

class MockUtterance {
  voice: { localService: boolean; lang: string; name: string } | null = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: SpeechSynthesisErrorCode }) => void) | null = null;
  constructor(public text: string) {}
}

const localEnglish = {
  name: "Local English",
  lang: "en-US",
  localService: true,
};
const localJapanese = {
  name: "Local Japanese",
  lang: "ja-JP",
  localService: true,
};
const remoteEnglish = {
  name: "Remote English",
  lang: "en-US",
  localService: false,
};

describe("local speech playback lifecycle (mocked, no real audio)", () => {
  let synthesis: {
    cancel: ReturnType<typeof vi.fn>;
    speak: ReturnType<typeof vi.fn>;
    getVoices: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    synthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn().mockReturnValue([localEnglish, localJapanese]),
    };
    vi.stubGlobal("window", { speechSynthesis: synthesis });
    vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
  });

  afterEach(() => {
    stopSpeech();
    vi.unstubAllGlobals();
  });

  const lastUtterance = () =>
    synthesis.speak.mock.calls.at(-1)![0] as MockUtterance;

  it("returns a useful immediate error when the speech API is unavailable", () => {
    vi.stubGlobal("window", {});
    const onEnd = vi.fn();
    const onError = vi.fn();
    expect(speakLocal("Hello", "en", onEnd, onError)).toContain("지원하지");
    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("never falls back to a remote voice or to the wrong language", () => {
    synthesis.getVoices.mockReturnValue([remoteEnglish, localJapanese]);
    expect(speakLocal("Hello", "en")).toContain("영어 기기 음성이 없어요");
    expect(synthesis.speak).not.toHaveBeenCalled();
    synthesis.getVoices.mockReturnValue([localEnglish]);
    expect(speakLocal("こんにちは", "ja")).toContain(
      "일본어 기기 음성이 없어요",
    );
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("selects a matching local voice even when a remote match is listed first", () => {
    synthesis.getVoices.mockReturnValue([
      remoteEnglish,
      localJapanese,
      localEnglish,
    ]);
    expect(speakLocal("Hello", "en")).toBeNull();
    expect(lastUtterance()).toMatchObject({
      voice: localEnglish,
      text: "Hello",
      lang: "en-US",
      rate: 0.85,
    });
  });

  it("reports asynchronous synthesis failure, then completes transport cleanup", () => {
    const order: string[] = [];
    const onEnd = vi.fn(() => order.push("end"));
    const onError = vi.fn(() => order.push("error"));
    expect(speakLocal("こんにちは", "ja", onEnd, onError)).toBeNull();
    const u = lastUtterance();
    const staleError = u.onerror;
    u.onerror?.({ error: "synthesis-failed" });
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("기기 음성 재생에 실패"),
    );
    expect(order).toEqual(["error", "end"]);
    expect(u.onend).toBeNull();
    expect(u.onerror).toBeNull();
    staleError?.({ error: "synthesis-failed" });
    expect(onError).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("detaches completion handlers and calls onEnd only once after success", () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    speakLocal("Hello", "en", onEnd, onError);
    const u = lastUtterance();
    const staleEnd = u.onend;
    u.onend?.();
    staleEnd?.();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(u.onend).toBeNull();
    expect(u.onerror).toBeNull();
  });

  it("invalidates old handlers before cancel can synchronously report interruption", () => {
    const oldEnd = vi.fn();
    const oldError = vi.fn();
    speakLocal("Old phrase", "en", oldEnd, oldError);
    const old = lastUtterance();
    const queuedError = old.onerror;
    const queuedEnd = old.onend;
    synthesis.cancel.mockImplementation(() => {
      expect(old.onerror).toBeNull();
      expect(old.onend).toBeNull();
      queuedError?.({ error: "interrupted" });
      queuedEnd?.();
    });
    const newEnd = vi.fn();
    const newError = vi.fn();
    expect(speakLocal("New phrase", "en", newEnd, newError)).toBeNull();
    queuedError?.({ error: "canceled" });
    queuedEnd?.();
    expect(oldEnd).not.toHaveBeenCalled();
    expect(oldError).not.toHaveBeenCalled();
    expect(newEnd).not.toHaveBeenCalled();
    expect(newError).not.toHaveBeenCalled();
    lastUtterance().onend?.();
    expect(newEnd).toHaveBeenCalledOnce();
  });

  it("explicit stop does not emit a false failure or resume callback", () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    speakLocal("Stop this phrase", "en", onEnd, onError);
    const u = lastUtterance();
    const delayedError = u.onerror;
    stopSpeech();
    delayedError?.({ error: "canceled" });
    expect(u.onend).toBeNull();
    expect(u.onerror).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("sanitizes synchronous speak errors and clears the failed utterance", () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    synthesis.speak.mockImplementationOnce(() => {
      throw new Error("private implementation details and phrase text");
    });
    const message = speakLocal("Private phrase", "en", onEnd, onError);
    const failed = lastUtterance();
    expect(message).toContain("기기 음성 재생에 실패");
    expect(message).not.toContain("private");
    expect(message).not.toContain("Private phrase");
    expect(failed.onend).toBeNull();
    expect(failed.onerror).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(speakLocal("Next phrase", "en")).toBeNull();
  });

  it("turns synchronous voice-enumeration errors into a safe immediate notice", () => {
    synthesis.getVoices.mockImplementation(() => {
      throw new Error("device service details");
    });
    expect(speakLocal("Hello", "en")).toContain("기기 음성 재생에 실패");
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
