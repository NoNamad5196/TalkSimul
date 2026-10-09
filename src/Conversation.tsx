import { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Lightbulb,
  Square,
  Send,
  Volume2,
  Clock3,
  ShieldCheck,
  MessageCircle,
  LoaderCircle,
} from "lucide-react";
import type {
  SessionConfig,
  Message,
  ConversationState,
  Hint,
} from "../shared/types";
import { Mascot, Modal, type Mood } from "./components";
import {
  demoHint,
  demoReply,
  formatTime,
  greeting,
  languages,
  levels,
  scenarioFor,
} from "./lib/content";
import { speakPronunciation, stopSpeech } from "./lib/audio";
import { apiPost } from "./lib/api";
import { RealtimeClient } from "./lib/realtime";
const stateLabels: Record<ConversationState, string> = {
  idle: "대화를 준비하고 있어요",
  connecting: "모루와 연결하고 있어요",
  listening: "편하게 이야기해 주세요",
  "user-speaking": "이야기를 듣고 있어요",
  thinking: "모루가 생각하고 있어요",
  speaking: "모루가 이야기하고 있어요",
  muted: "마이크가 쉬고 있어요",
  error: "잠깐, 연결을 확인해 주세요",
  ended: "오늘도 함께해서 좋았어요",
};
const moodFor = (s: ConversationState): Mood =>
  s === "thinking" || s === "connecting"
    ? "thinking"
    : s === "speaking"
      ? "speaking"
      : s === "listening" || s === "user-speaking"
        ? "listening"
        : "neutral";
export default function Conversation({
  config,
  onEnd,
}: {
  config: SessionConfig;
  onEnd: (
    messages: Message[],
    duration: number,
    startedAt: number,
    incompleteTranscription?: boolean,
  ) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]),
    [state, setState] = useState<ConversationState>("connecting"),
    [muted, setMuted] = useState(false),
    [duration, setDuration] = useState(0),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [hintOpen, setHintOpen] = useState(false),
    [hint, setHint] = useState<Hint | null>(null),
    [hintError, setHintError] = useState(""),
    [hintLoading, setHintLoading] = useState(false),
    [confirmEnd, setConfirmEnd] = useState(false),
    [audioNotice, setAudioNotice] = useState(""),
    [finishing, setFinishing] = useState(false);
  const client = useRef<RealtimeClient | null>(null),
    started = useRef(Date.now()),
    messageRef = useRef<Message[]>([]),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    mounted = useRef(true),
    paused = useRef(false),
    hintAbort = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  const append = (m: Message) => {
    // Keep the final transcript available synchronously when finish() drains
    // its last event, even before React commits the next screen update.
    const prev = messageRef.current;
    const found = prev.findIndex((x) => x.id === m.id);
    const next =
      found < 0 ? [...prev, m] : prev.map((x) => (x.id === m.id ? m : x));
    next.sort((a, b) => a.timestamp - b.timestamp);
    messageRef.current = next;
    setMessages(next);
  };
  useEffect(() => {
    mounted.current = true;
    started.current = Date.now();
    if (config.mode === "demo") {
      const m: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: greeting(config),
        timestamp: Date.now(),
        source: "demo",
      };
      messageRef.current = [m];
      setMessages([m]);
      setState("listening");
    } else {
      const rtc = new RealtimeClient({
        onState: (s) => {
          if (mounted.current) setState(s);
        },
        onMessage: (m) => {
          if (mounted.current) append(m);
        },
        onError: (e) => {
          if (mounted.current) setError(e);
        },
      });
      client.current = rtc;
      void rtc.connect(config);
    }
    const tick = setInterval(
      () => setDuration(Math.floor((Date.now() - started.current) / 1000)),
      1000,
    );
    const leave = () => {
      client.current?.close();
      stopSpeech();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      clearInterval(tick);
      if (timer.current) clearTimeout(timer.current);
      hintAbort.current?.abort();
      leave();
      window.removeEventListener("pagehide", leave);
    };
  }, [config]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [messages]);
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    hintAbort.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    stopSpeech();
    const elapsed = Math.floor((Date.now() - started.current) / 1000);
    const result = await client.current?.finish();
    if (!mounted.current) return;
    onEnd(
      messageRef.current,
      elapsed,
      started.current,
      result?.incompleteTranscription,
    );
  };
  const send = () => {
    const text = draft.trim();
    if (!text || text.length > 2000) return;
    setError("");
    if (config.mode === "live") {
      if (client.current?.sendText(text)) setDraft("");
      return;
    }
    const before = messageRef.current;
    append({
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
      source: "typed",
    });
    setDraft("");
    setState("thinking");
    timer.current = setTimeout(() => {
      if (!mounted.current) return;
      append({
        id: crypto.randomUUID(),
        role: "assistant",
        text: demoReply(config, before, text),
        timestamp: Date.now(),
        source: "demo",
      });
      setState(muted ? "muted" : "listening");
    }, 850);
  };
  const openHint = async () => {
    paused.current = true;
    client.current?.pause();
    stopSpeech();
    setHintOpen(true);
    setHintError("");
    setHint(null);
    setHintLoading(true);
    const controller = new AbortController();
    hintAbort.current = controller;
    try {
      const h =
        config.mode === "demo"
          ? demoHint(config, messageRef.current)
          : await apiPost<Hint>(
              "hint",
              { config, messages: messageRef.current },
              controller.signal,
            );
      if (!controller.signal.aborted) setHint(h);
    } catch (e) {
      if (!controller.signal.aborted)
        setHintError(
          e instanceof Error ? e.message : "힌트를 불러오지 못했어요.",
        );
    } finally {
      if (!controller.signal.aborted) setHintLoading(false);
    }
  };
  const closeHint = () => {
    hintAbort.current?.abort();
    stopSpeech();
    paused.current = false;
    client.current?.resume();
    setHintOpen(false);
    setAudioNotice("");
  };
  const play = (text: string) => {
    client.current?.pause();
    speakPronunciation(
      text,
      config,
      () => {
        if (mounted.current && !paused.current) client.current?.resume();
      },
      setAudioNotice,
    );
  };
  return (
    <main className="session-page">
      <div className="session-heading">
        <div>
          <p className="eyebrow">OUR LITTLE CONVERSATION</p>
          <h1>{scenarioFor(config.scenario).title}</h1>
          <div className="session-tags">
            <span>{languages[config.language].name}</span>
            <span>{levels[config.level].name}</span>
            <span className="time">
              <Clock3 size={14} />
              {formatTime(duration)}
            </span>
          </div>
        </div>
        <button
          className="quiet-button end-top"
          onClick={() => setConfirmEnd(true)}
        >
          <Square size={15} /> 대화 마치기
        </button>
      </div>
      {config.mode === "demo" && (
        <div className="demo-banner">
          <span className="pill">데모</span>
          <span>
            정해진 예시 응답으로 흐름을 체험해요. 마이크·AI 연결은 사용하지
            않아요.
          </span>
        </div>
      )}
      <div className="conversation-layout">
        <section className="friend-stage" aria-label="모루의 대화 상태">
          <div className="friend-name">
            <span className="presence-dot" /> 나의 대화 친구, 모루
          </div>
          <div className="stage-speech">
            {state === "error"
              ? "괜찮아, 천천히 다시 해 보자."
              : state === "thinking"
                ? "음… 잠깐만 생각해 볼게!"
                : state === "muted"
                  ? "잠깐 쉬어도 괜찮아."
                  : "완벽하지 않아도, 네 이야기가 좋아!"}
          </div>
          <Mascot mood={moodFor(state)} />
          <div
            className={`voice-wave ${state === "speaking" || state === "user-speaking" ? "active" : ""}`}
            aria-hidden="true"
          >
            {Array.from({ length: 9 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${[10, 19, 29, 17, 36, 22, 30, 16, 10][i]}px`,
                }}
              />
            ))}
          </div>
          <p className="state-label" role="status">
            {hintOpen ? "표현을 함께 찾아보고 있어요" : stateLabels[state]}
          </p>
          <p className="stage-footnote">
            틀려도 괜찮아요. 이야기는 계속되니까!
          </p>
        </section>
        <section className="conversation-panel" aria-label="대화 내용">
          <div className="panel-title">
            <MessageCircle size={18} />
            <h2>우리의 이야기</h2>
            <span>
              {messages.filter((m) => m.role === "user").length}번의 한마디
            </span>
          </div>
          <div
            className="transcript"
            tabIndex={0}
            aria-label="이전 발화를 포함한 대화 내용"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.length === 0 && (
              <div className="connecting-message">
                <LoaderCircle
                  className={state === "error" ? "" : "spin"}
                  size={24}
                />
                <p>
                  {state === "error"
                    ? "아직 대화를 시작하지 못했어요."
                    : "첫인사를 준비하고 있어요…"}
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`message message-${m.role}`}>
                <span className="message-author">
                  {m.role === "user" ? "나" : "모루"}
                  {m.source === "demo" && <small>예시 응답</small>}
                </span>
                <div className="message-bubble" lang={config.language}>
                  {m.text}
                </div>
                {m.role === "assistant" && config.mode === "demo" && (
                  <button
                    className="text-audio"
                    onClick={() => play(m.text)}
                    aria-label="모루의 예시 문장 발음 듣기"
                  >
                    <Volume2 size={14} /> 발음 듣기
                  </button>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
              <span>대화를 마치면 지금까지의 발화는 복기에 남아요.</span>
            </div>
          )}
          {audioNotice && (
            <p className="audio-notice" role="status">
              {audioNotice}
            </p>
          )}
          <form
            className="text-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label className="sr-only" htmlFor="message">
              {config.mode === "demo"
                ? "데모에서 직접 말할 문장 입력"
                : "텍스트로 말하기"}
            </label>
            <input
              id="message"
              lang={config.language}
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                config.mode === "demo"
                  ? "직접 문장을 입력해 보세요"
                  : "텍스트로도 이야기할 수 있어요"
              }
              disabled={state === "connecting" || state === "error"}
            />
            <button
              type="submit"
              className="send-button"
              aria-label="문장 보내기"
              disabled={
                !draft.trim() ||
                state === "thinking" ||
                state === "connecting" ||
                state === "error"
              }
            >
              <Send size={19} />
            </button>
          </form>
          {config.mode === "demo" && (
            <button
              className="draft-example"
              onClick={() =>
                setDraft(
                  config.language === "en"
                    ? "I goed to a café yesterday."
                    : "昨日、カフェに行きます。",
                )
              }
            >
              연습할 예문 넣기 <span>전송 전 직접 바꿔 보세요</span>
            </button>
          )}
        </section>
      </div>
      <div className="session-controls">
        <button
          className="hint-button"
          onClick={() => void openHint()}
          disabled={state === "connecting" || state === "error"}
        >
          <Lightbulb size={22} />
          <span>뭐라고 말하지?</span>
        </button>
        <button
          className={`mic-button ${muted ? "is-muted" : ""}`}
          disabled={
            config.mode === "demo" ||
            state === "connecting" ||
            state === "error"
          }
          aria-label={
            config.mode === "demo"
              ? "데모에서는 마이크를 사용하지 않아요"
              : muted
                ? "마이크 켜기"
                : "마이크 끄기"
          }
          aria-pressed={config.mode === "live" && !muted}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            client.current?.setMuted(next);
          }}
        >
          {muted ? <MicOff size={27} /> : <Mic size={27} />}
        </button>
        <button className="finish-button" onClick={() => setConfirmEnd(true)}>
          <Square size={18} />
          <span>대화 마치기</span>
        </button>
      </div>
      <p className="privacy-note">
        <ShieldCheck size={14} />
        {config.mode === "demo"
          ? "데모에서는 마이크가 켜지지 않아요"
          : "음성은 OpenAI로 전송돼요 · 원본 음성은 기기에 저장하지 않아요"}
      </p>
      {hintOpen && (
        <Modal title="이렇게 말해 볼까요?" onClose={closeHint}>
          <div className="hint-intro">
            <span className="hint-icon">
              <Lightbulb size={27} />
            </span>
            <p>
              한 문장만 떠올라도 충분해요.
              <br />
              <strong>모루는 잠깐 기다리고 있어요.</strong>
            </p>
          </div>
          {config.mode === "demo" && (
            <p className="small-label">데모 · 현재 상황에 맞춘 예시 힌트</p>
          )}
          {hintLoading ? (
            <div className="loading-block">
              <LoaderCircle className="spin" />
              말하기 좋은 표현을 찾고 있어요…
            </div>
          ) : hintError ? (
            <div className="inline-error" role="alert">
              {hintError}
              <button className="quiet-button" onClick={() => void openHint()}>
                다시 불러오기
              </button>
            </div>
          ) : (
            hint && (
              <div className="hint-card">
                <p lang={config.language}>{hint.text}</p>
                <span>{hint.meaning}</span>
                {hint.note && <small>{hint.note}</small>}
                <button
                  className="quiet-button"
                  onClick={() => play(hint.text)}
                >
                  <Volume2 size={18} /> 발음 듣기
                </button>
              </div>
            )
          )}
          {audioNotice && (
            <p className="audio-notice" role="status">
              {audioNotice}
            </p>
          )}
          <p className="hint-notice">
            힌트는 내 발화로 기록되지 않아요.
            <br />
            대화로 돌아가 내 목소리로 말해 보세요.
            {config.mode === "live" && (
              <>
                <br />
                기기 음성이 없거나 재생에 실패하면 이 문장을 OpenAI로 보내
                발음을 만들어요. AI 음성이 재생돼요.
              </>
            )}
          </p>
          <button className="button primary full" onClick={closeHint}>
            이제 말해 볼게요
          </button>
        </Modal>
      )}
      {confirmEnd && (
        <Modal
          title="오늘의 이야기를 마칠까요?"
          onClose={() => {
            if (!finishing) setConfirmEnd(false);
          }}
        >
          <p className="modal-copy">
            지금까지 나눈 대화를 모아 볼게요. 내가 남긴 표현은 이 기기의 연습
            기록에 저장돼요.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={finishing}
              onClick={() => setConfirmEnd(false)}
            >
              조금 더 이야기하기
            </button>
            <button
              className="button primary"
              disabled={finishing}
              onClick={() => void finish()}
            >
              {finishing ? "마지막 발화를 정리하고 있어요…" : "마치고 복기하기"}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
