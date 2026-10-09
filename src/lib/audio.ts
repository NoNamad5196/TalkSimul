import type { Language, SessionConfig } from "../../shared/types";
import { apiPost } from "./api";
let current: SpeechSynthesisUtterance | null = null;
type PronunciationJob = {
  controller: AbortController | null;
  audio: HTMLAudioElement | null;
  objectUrl: string | null;
};
let pronunciation: PronunciationJob | null = null;

function releasePronunciation(job: PronunciationJob) {
  job.controller?.abort();
  job.controller = null;
  if (job.audio) {
    job.audio.onended = null;
    job.audio.onerror = null;
    const audio = job.audio;
    for (const cleanup of [
      () => audio.pause(),
      () => audio.removeAttribute("src"),
      () => audio.load(),
    ]) {
      try {
        cleanup();
      } catch {
        // A detached/closed output must not prevent the remaining cleanup.
      }
    }
    job.audio = null;
  }
  if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
  job.objectUrl = null;
}

function detach(utterance: SpeechSynthesisUtterance) {
  utterance.onend = null;
  utterance.onerror = null;
}

function playbackError(error?: SpeechSynthesisErrorCode): string {
  if (error === "not-allowed")
    return "브라우저가 발음 재생을 막았어요. 사이트의 소리 재생을 허용한 뒤 다시 눌러 주세요.";
  if (error === "audio-busy" || error === "audio-hardware")
    return "오디오 출력 장치를 사용할 수 없어요. 스피커나 이어폰 연결을 확인한 뒤 다시 눌러 주세요.";
  return "기기 음성 재생에 실패했어요. 브라우저와 오디오 출력 장치를 확인한 뒤 다시 눌러 주세요.";
}

export function stopSpeech() {
  const stopped = pronunciation;
  pronunciation = null;
  if (stopped) releasePronunciation(stopped);
  // cancel() can synchronously fire interrupted/canceled events. Invalidate the
  // old utterance first so it cannot report an error or resume a newer session.
  if (current) detach(current);
  current = null;
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Cleanup must remain safe during browser teardown.
    }
  }
}
export function speakLocal(
  text: string,
  language: Language,
  onEnd?: () => void,
  onError?: (message: string) => void,
): string | null {
  stopSpeech();
  return startLocal(text, language, onEnd, onError);
}

function startLocal(
  text: string,
  language: Language,
  onEnd?: () => void,
  onError?: (message: string) => void,
): string | null {
  if (
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  )
    return "이 브라우저에서는 발음 재생을 지원하지 않아요.";
  let utterance: SpeechSynthesisUtterance | null = null;
  try {
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.localService && v.lang.toLowerCase().startsWith(language));
    if (!voice)
      return `${language === "en" ? "영어" : "일본어"} 기기 음성이 없어요. 운영체제에서 해당 언어 음성을 설치하면 발음을 들을 수 있어요.`;
    const u = new SpeechSynthesisUtterance(text);
    utterance = u;
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.85;
    const finish = (error?: string) => {
      if (current !== u) return;
      detach(u);
      current = null;
      try {
        if (error) onError?.(error);
      } finally {
        onEnd?.();
      }
    };
    u.onend = () => finish();
    u.onerror = (event) => finish(playbackError(event.error));
    current = u;
    window.speechSynthesis.speak(u);
    return null;
  } catch {
    if (utterance) detach(utterance);
    if (current === utterance) current = null;
    // Immediate errors use the return value, matching unavailable-voice errors.
    return playbackError();
  }
}

/**
 * Local speech remains the first choice. Only an explicitly selected live
 * session may send a phrase to the server if the local voice is unavailable.
 * The server independently enforces the paid API setting. Nothing is cached.
 * Cancellation never invokes onEnd; success and final failure invoke it once.
 */
export function speakPronunciation(
  text: string,
  config: SessionConfig,
  onEnd?: () => void,
  onNotice?: (message: string) => void,
): void {
  stopSpeech();
  const job: PronunciationJob = {
    controller: null,
    audio: null,
    objectUrl: null,
  };
  pronunciation = job;
  const active = () => pronunciation === job;
  const finish = (notice = "") => {
    if (!active()) return;
    pronunciation = null;
    releasePronunciation(job);
    try {
      onNotice?.(notice);
    } finally {
      onEnd?.();
    }
  };
  const serverSpeech = async () => {
    if (!active()) return;
    onNotice?.("발음 음성을 준비하고 있어요…");
    const controller = new AbortController();
    job.controller = controller;
    try {
      const data = await apiPost<{ audio: string; mimeType: string }>(
        "speech",
        { config, text },
        controller.signal,
      );
      if (!active()) return;
      if (
        data.mimeType !== "audio/mpeg" ||
        typeof data.audio !== "string" ||
        !data.audio.length ||
        data.audio.length > 24_000_000
      )
        throw new Error("invalid speech response");
      const bytes = Uint8Array.from(atob(data.audio), (character) =>
        character.charCodeAt(0),
      );
      job.objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "audio/mpeg" }),
      );
      const audio = new Audio();
      job.audio = audio;
      audio.onended = () => finish();
      audio.onerror = () =>
        finish(
          "발음 재생에 실패했어요. 스피커나 이어폰과 브라우저의 소리 재생 설정을 확인한 뒤 다시 눌러 주세요.",
        );
      audio.src = job.objectUrl;
      await audio.play();
      if (active()) onNotice?.("발음을 듣고 있어요.");
    } catch {
      if (active())
        finish(
          "발음 음성을 불러오거나 재생하지 못했어요. 연결 및 데이터 설정과 소리 재생 권한을 확인한 뒤 다시 눌러 주세요.",
        );
    }
  };
  let localFailed = false;
  const localFailure = (message: string) => {
    if (!active() || localFailed) return;
    localFailed = true;
    if (config.mode === "live") void serverSpeech();
    else finish(message);
  };
  onNotice?.("");
  const immediateError = startLocal(
    text,
    config.language,
    () => {
      if (!localFailed) finish();
    },
    localFailure,
  );
  if (immediateError) localFailure(immediateError);
}
