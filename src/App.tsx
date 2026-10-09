import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { registerPracticeTool } from "./lib/practice-tool";
import {
  Home,
  Compass,
  BookOpen,
  Settings2,
  Mic,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  ShieldCheck,
  Volume2,
  RotateCcw,
  Trash2,
  Clock3,
  Check,
  Sprout,
  LoaderCircle,
  MessageCircle,
  SlidersHorizontal,
  Heart,
  Monitor,
  AlertCircle,
} from "lucide-react";
import type {
  ApiStatus,
  SessionConfig,
  SessionRecord,
  Message,
  Review,
  Level,
  ScenarioId,
} from "../shared/types";
import {
  Brand,
  Empty,
  LevelSprouts,
  Mascot,
  Modal,
  ScenarioIcon,
} from "./components";
import {
  dateLabel,
  demoReview,
  formatTime,
  languages,
  levels,
  scenarioFor,
  scenarios,
} from "./lib/content";
import { deleteRecord, loadRecords, saveRecord } from "./lib/storage";
import { apiPost } from "./lib/api";
import { speakPronunciation, stopSpeech } from "./lib/audio";
import Conversation from "./Conversation";
type Page = "home" | "practice" | "prepare" | "session" | "review" | "history";
const initial: SessionConfig = {
  language: "en",
  level: "beginner",
  scenario: "free",
  mode: "live",
};
export default function App() {
  const [page, setPage] = useState<Page>("home"),
    [config, setConfig] = useState<SessionConfig>(initial),
    [records, setRecords] = useState<SessionRecord[]>([]),
    [storageError, setStorageError] = useState(""),
    [record, setRecord] = useState<SessionRecord | null>(null),
    [status, setStatus] = useState<ApiStatus | null>(null),
    [statusError, setStatusError] = useState(""),
    [settings, setSettings] = useState(false),
    [levelPicker, setLevelPicker] = useState(false),
    [consent, setConsent] = useState(false),
    [reviewLoading, setReviewLoading] = useState(false),
    [audioNotice, setAudioNotice] = useState(""),
    [deleteId, setDeleteId] = useState<string | null>(null),
    [leaveTo, setLeaveTo] = useState<Page | null>(null),
    [filter, setFilter] = useState<"all" | "en" | "ja">("all");
  const reviewAbort = useRef<AbortController | null>(null),
    reviewTarget = useRef<string | null>(null),
    deletedRecords = useRef(new Set<string>()),
    previousPage = useRef<Page>("home");
  const stagePractice = useRef<(next: SessionConfig) => unknown>(() => null);
  stagePractice.current = (next) => {
    if (page === "session")
      throw new Error("End the active conversation on screen first.");
    flushSync(() => {
      prepare(next.scenario);
      setConfig(next);
      setSettings(false);
      setLevelPicker(false);
    });
    return {
      page: "prepare",
      config: next,
      consentRequired: next.mode === "live",
      started: false,
    };
  };
  useEffect(
    () => registerPracticeTool((next) => stagePractice.current(next)),
    [],
  );
  useEffect(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
    const saved = loadRecords();
    setRecords(saved.records);
    setStorageError(saved.error ?? "");
    void refreshStatus();
    window.addEventListener("pagehide", stopSpeech);
    return () => {
      reviewAbort.current?.abort();
      stopSpeech();
      window.removeEventListener("pagehide", stopSpeech);
    };
  }, []);
  useEffect(() => {
    if (previousPage.current !== page) {
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>("main h1")?.focus();
      previousPage.current = page;
    }
  }, [page]);
  async function refreshStatus() {
    setStatusError("");
    try {
      const r = await fetch("/api/status", {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error();
      setStatus(await r.json());
    } catch {
      setStatus(null);
      setStatusError(
        "서버에 연결하지 못했어요. 인터넷 연결을 확인하거나 새로고침해 주세요.",
      );
    }
  }
  const navigate = (next: Page) => {
    if (page === "session") {
      setLeaveTo(next);
      return;
    }
    reviewAbort.current?.abort();
    setReviewLoading(false);
    stopSpeech();
    setAudioNotice("");
    setPage(next);
  };
  const prepare = (scenario: ScenarioId) => {
    reviewAbort.current?.abort();
    setReviewLoading(false);
    stopSpeech();
    setConfig((c) => ({ ...c, scenario }));
    setConsent(false);
    setPage("prepare");
  };
  const persist = (r: SessionRecord) => {
    const saved = saveRecord(r);
    setRecords(saved.records);
    setStorageError(saved.error ?? "");
  };
  const end = async (
    messages: Message[],
    duration: number,
    startedAt: number,
    incompleteTranscription?: boolean,
  ) => {
    const r: SessionRecord = {
      id: crypto.randomUUID(),
      config: { ...config },
      startedAt,
      duration,
      messages,
      review: null,
      incompleteTranscription,
    };
    setRecord(r);
    setPage("review");
    persist(r);
    await generateReview(r);
  };
  async function generateReview(r: SessionRecord) {
    reviewAbort.current?.abort();
    reviewTarget.current = r.id;
    const controller = new AbortController();
    reviewAbort.current = controller;
    setReviewLoading(true);
    try {
      const review =
        r.config.mode === "demo"
          ? demoReview(r.config, r.messages)
          : await apiPost<Review>(
              "review",
              { config: r.config, messages: r.messages },
              controller.signal,
            );
      if (
        controller.signal.aborted ||
        deletedRecords.current.has(r.id) ||
        reviewTarget.current !== r.id
      )
        return;
      const complete = { ...r, review, reviewError: undefined };
      setRecord(complete);
      persist(complete);
    } catch (e) {
      if (
        controller.signal.aborted ||
        deletedRecords.current.has(r.id) ||
        reviewTarget.current !== r.id
      )
        return;
      const failed = {
        ...r,
        reviewError: e instanceof Error ? e.message : "복기를 만들지 못했어요.",
      };
      setRecord(failed);
      persist(failed);
    } finally {
      if (!controller.signal.aborted) setReviewLoading(false);
    }
  }
  const openRecord = (r: SessionRecord) => {
    reviewAbort.current?.abort();
    setReviewLoading(false);
    setRecord(r);
    navigate("review");
  };
  const retry = () => {
    if (record) {
      setConfig({ ...record.config });
      setConsent(false);
      navigate("prepare");
    }
  };
  const play = (text: string, playbackConfig: SessionConfig) => {
    speakPronunciation(text, playbackConfig, undefined, setAudioNotice);
  };
  const selectLanguage = (language: SessionConfig["language"]) =>
    setConfig((c) => ({ ...c, language }));
  const languageSwitch = (
    <div className="language-switch" aria-label="연습 언어">
      {(["en", "ja"] as const).map((l) => (
        <button
          key={l}
          className={config.language === l ? "selected" : ""}
          aria-pressed={config.language === l}
          onClick={() => selectLanguage(l)}
        >
          <span className={`language-mark ${l}`}>{languages[l].flag}</span>
          {languages[l].name}
          <span className="native-label">{languages[l].native}</span>
          {config.language === l && <Check size={16} />}
        </button>
      ))}
    </div>
  );
  const scenarioCards = (all = false) => (
    <div className={`scenario-grid ${all ? "expanded" : ""}`}>
      {scenarios
        .filter((s) => s.id !== "free")
        .map((s, i) => (
          <button
            key={s.id}
            className={`scenario-card ${s.color}`}
            onClick={() => prepare(s.id)}
          >
            <span className="scenario-card-top">
              <span className="scenario-icon">
                <ScenarioIcon id={s.id} size={30} />
              </span>
              <span className="scenario-number">0{i + 1}</span>
            </span>
            <span className="scenario-translation" lang={config.language}>
              {s[config.language]}
            </span>
            <strong>{s.title}</strong>
            {all && (
              <span className="scenario-description">{s.description}</span>
            )}
            <span className="scenario-bottom">
              {s.tag}
              <ChevronRight size={17} />
            </span>
          </button>
        ))}
    </div>
  );
  const recordList = (items: SessionRecord[]) => (
    <div className="record-list">
      {items.map((r) => (
        <div className="record-row" key={r.id}>
          <button className="record-open" onClick={() => openRecord(r)}>
            <span
              className={`record-icon ${scenarioFor(r.config.scenario).color}`}
            >
              <ScenarioIcon id={r.config.scenario} />
            </span>
            <span className="record-description">
              <strong>
                {scenarioFor(r.config.scenario).title}
                {r.config.mode === "demo" && (
                  <small className="demo-tag">데모</small>
                )}
              </strong>
              <span>
                {dateLabel(r.startedAt)} · {languages[r.config.language].name} ·{" "}
                {levels[r.config.level].name}
              </span>
            </span>
            <span className="record-duration">
              {formatTime(r.duration)}
              <ChevronRight size={19} />
            </span>
          </button>
          <button
            className="icon-button delete-button"
            onClick={() => setDeleteId(r.id)}
            aria-label={`${scenarioFor(r.config.scenario).title} 기록 삭제`}
          >
            <Trash2 size={17} />
          </button>
        </div>
      ))}
    </div>
  );
  return (
    <div className={`app page-${page}`}>
      <header className="site-header">
        <div className="header-inner">
          <button
            className="brand-button"
            onClick={() => navigate("home")}
            aria-label="TalkSimul 홈"
          >
            <Brand />
          </button>
          <nav aria-label="주 메뉴">
            {(
              [
                { id: "home", label: "대화 아지트", icon: Home },
                { id: "practice", label: "상황별 연습", icon: Compass },
                { id: "history", label: "연습 기록", icon: BookOpen },
              ] as const
            ).map((n) => (
              <button
                key={n.id}
                className={page === n.id ? "active" : ""}
                onClick={() => navigate(n.id)}
                aria-current={page === n.id ? "page" : undefined}
              >
                <n.icon size={19} />
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="header-tools">
            <span className="local-badge">
              <span /> VOICE PRACTICE
            </span>
            <button
              className="icon-button settings-button"
              aria-label="연결 및 데이터 설정"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={22} />
            </button>
          </div>
        </div>
      </header>
      {page === "home" && (
        <main className="home-page">
          <div className="welcome-row">
            <div>
              <p className="eyebrow">
                <span className="tiny-sun">✳</span> A LITTLE TALK, A LITTLE
                GROWTH
              </p>
              <h1 tabIndex={-1}>
                어서 와요, 오늘도 <span>한마디!</span>
              </h1>
              <p className="page-intro">
                틀려도 괜찮은 곳, 여기는 우리의 작은 회화 아지트예요.
              </p>
            </div>
            <div className="date-sticker">
              <Sprout size={19} />
              <span>
                잘하는 것보다
                <br />
                <strong>말해 보는 게 먼저</strong>
              </span>
            </div>
          </div>
          <div className="home-toolbar">
            {languageSwitch}
            <button className="level-chip" onClick={() => setLevelPicker(true)}>
              <Sprout size={18} />
              <span>
                지금은 <strong>{levels[config.level].name}</strong>
              </span>
              <SlidersHorizontal size={16} />
            </button>
          </div>
          <section className="hero">
            <div className="hero-copy">
              <span className="label-sticker">
                <MessageCircle size={15} /> 오늘의 수다 메이트
              </span>
              <h2>
                무슨 이야기든 좋아.
                <br />
                <span>우리, 말해 볼까?</span>
              </h2>
              <p>
                오늘 먹은 점심부터 문득 떠오른 생각까지.
                <br />
                모루가 당신의 이야기를 기다리고 있어요.
              </p>
              <button
                className="button primary hero-cta"
                onClick={() => prepare("free")}
              >
                <Mic size={22} />
                자유 대화 시작
              </button>
              <span className="hero-caption">
                주제 없이 가볍게 · 내 속도에 맞춰서
              </span>
            </div>
            <div className="hero-scene">
              <div className="scene-orbit" />
              <div className="hello-bubble">
                {config.language === "en"
                  ? "Hey, how was your day?"
                  : "今日はどんな一日だった？"}
                <Heart size={15} />
              </div>
              <span className="scene-spark spark-one">✦</span>
              <span className="scene-spark spark-two">✧</span>
              <Mascot mood="welcoming" />
              <div className="character-tag">
                <span className="presence-dot" /> 모루 <span>·</span> 이야기
                들을 준비 완료!
              </div>
            </div>
            <span className="hero-tape" />
          </section>
          <section className="section scenarios-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">A SMALL ADVENTURE</p>
                <h2>오늘은 이런 상황 어때요?</h2>
              </div>
              <button
                className="text-link"
                onClick={() => navigate("practice")}
              >
                전체 보기 <ChevronRight size={17} />
              </button>
            </div>
            {scenarioCards()}
          </section>
          <section className="section recent-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">WORDS TO KEEP</p>
                <h2>다시 꺼내 보는 나의 한마디</h2>
              </div>
              <button className="text-link" onClick={() => navigate("history")}>
                연습 기록 <ChevronRight size={17} />
              </button>
            </div>
            {records.length ? (
              recordList(records.slice(0, 3))
            ) : (
              <div className="recent-empty">
                <span className="notebook-icon">
                  <BookOpen size={29} />
                </span>
                <div>
                  <strong>첫 번째 이야기가 여기에 남을 거예요.</strong>
                  <p>대화를 마치면 내가 말한 표현을 함께 돌아봐요.</p>
                </div>
                <span className="empty-doodle">hello!</span>
              </div>
            )}
          </section>
          {storageError && (
            <p className="inline-error" role="alert">
              {storageError}
            </p>
          )}
          <div className="home-footer-note">
            <ShieldCheck size={16} />
            <span>언제든 가볍게. 연습 기록은 이 기기에만 저장돼요.</span>
          </div>
        </main>
      )}
      {page === "practice" && (
        <main className="standard-page">
          <p className="eyebrow">ONE SCENE, ONE SMALL ADVENTURE</p>
          <h1 tabIndex={-1}>오늘의 대화 무대를 골라요</h1>
          <p className="page-intro">
            작은 연습 하나가, 여행과 일상에서의 자신감이 되도록.
          </p>
          <div className="home-toolbar">
            {languageSwitch}
            <button className="level-chip" onClick={() => setLevelPicker(true)}>
              <Sprout size={18} />
              {levels[config.level].name}
              <SlidersHorizontal size={16} />
            </button>
          </div>
          <button className="free-banner" onClick={() => prepare("free")}>
            <span className="scenario-icon">
              <MessageCircle size={29} />
            </span>
            <span>
              <strong>마음 가는 대로, 자유 대화</strong>
              <small>정해진 상황 없이 모루와 이야기해요.</small>
            </span>
            <ChevronRight size={24} />
          </button>
          {scenarioCards(true)}
          <div className="tip-strip">
            <Sparkles size={19} />
            모루가 상황에 맞는 역할로 함께해요. 대화 중에는 실수를 지적하지
            않아요.
          </div>
        </main>
      )}
      {page === "prepare" && (
        <main className="prepare-page">
          <button className="back-link" onClick={() => navigate("home")}>
            <ChevronLeft size={18} />
            아지트로 돌아가기
          </button>
          <div className="center-heading">
            <p className="eyebrow">BEFORE WE SAY HELLO</p>
            <h1 tabIndex={-1}>우리, 이렇게 이야기해요</h1>
            <p className="page-intro">
              잘해야 한다는 부담은 내려놓고, 나에게 맞는 속도로.
            </p>
          </div>
          <section className="prepare-card">
            <div className="prepare-context">
              <span
                className={`scenario-icon ${scenarioFor(config.scenario).color}`}
              >
                <ScenarioIcon id={config.scenario} size={28} />
              </span>
              <div>
                <span className="small-label">
                  {languages[config.language].name} ·{" "}
                  {config.scenario === "free" ? "자유회화" : "상황별 연습"}
                </span>
                <h2>{scenarioFor(config.scenario).title}</h2>
                <p>모루의 역할: {scenarioFor(config.scenario).role}</p>
              </div>
              <Mascot mood="neutral" />
            </div>
            <div className="prepare-section">
              <h3>어떤 속도가 편한가요?</h3>
              <div className="level-options">
                {(
                  Object.entries(levels) as [Level, (typeof levels)[Level]][]
                ).map(([key, l], i) => (
                  <button
                    key={key}
                    className={`level-option ${config.level === key ? "selected" : ""}`}
                    aria-pressed={config.level === key}
                    onClick={() => setConfig((c) => ({ ...c, level: key }))}
                  >
                    <span className="level-option-top">
                      <LevelSprouts count={i + 1} />
                      <span className="radio-indicator">
                        {config.level === key && <Check size={12} />}
                      </span>
                    </span>
                    <strong>{l.name}</strong>
                    <span>{l.subtitle}</span>
                    <small>{l.description}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="prepare-section">
              <h3>대화 방식</h3>
              <div className="mode-options">
                <button
                  className={config.mode === "demo" ? "selected" : ""}
                  onClick={() => {
                    setConfig((c) => ({ ...c, mode: "demo" }));
                    setConsent(false);
                  }}
                  aria-pressed={config.mode === "demo"}
                >
                  <Monitor size={21} />
                  <span>
                    <strong>데모로 둘러보기</strong>
                    <small>직접 텍스트 입력 · 예시 응답 · 무료</small>
                  </span>
                  <span className="radio-indicator">
                    {config.mode === "demo" && <Check size={12} />}
                  </span>
                </button>
                <button
                  className={config.mode === "live" ? "selected" : ""}
                  onClick={() => {
                    setConfig((c) => ({ ...c, mode: "live" }));
                    setConsent(false);
                  }}
                  aria-pressed={config.mode === "live"}
                >
                  <Mic size={21} />
                  <span>
                    <strong>실시간 AI 음성 대화</strong>
                    <small>마이크로 이야기 · API 사용료 발생</small>
                  </span>
                  <span className="radio-indicator">
                    {config.mode === "live" && <Check size={12} />}
                  </span>
                </button>
              </div>
              {config.mode === "demo" ? (
                <p className="setup-note">
                  데모는 실제 AI 회화가 아니에요. 마이크와 외부 API를 사용하지
                  않으며, 복기에는 직접 입력한 문장만 남아요.
                </p>
              ) : (
                <div className="live-info">
                  <p>
                    <ShieldCheck size={17} /> 시작하면 마이크 음성과 대화
                    텍스트가 OpenAI로 전송돼요. 힌트와 복기에도 대화 텍스트를
                    사용해요. 기기 음성 재생이 불가능하면 발음 문장도 OpenAI로
                    보내 AI 음성을 만들어요. 원본 음성은 기기에 저장하지 않아요.
                  </p>
                  {!status?.configured || !status?.enabled ? (
                    <div className="setup-required">
                      <AlertCircle size={19} />
                      <span>서버의 AI 연결을 확인하고 있어요.</span>
                      <button
                        className="text-link"
                        onClick={() => setSettings(true)}
                      >
                        설정 보기
                      </button>
                    </div>
                  ) : (
                    <label className="consent-check">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      음성·대화 전송과 API 비용을 확인했어요.
                    </label>
                  )}
                </div>
              )}
            </div>
            <button
              className="button primary full start-button"
              disabled={
                config.mode === "live" &&
                (!status?.configured || !status.enabled || !consent)
              }
              onClick={() => {
                stopSpeech();
                setPage("session");
              }}
            >
              <Mic size={21} />
              {config.mode === "demo"
                ? "데모 대화 시작"
                : "마이크 켜고 대화 시작"}
            </button>
            <p className="prepare-bottom">
              잠깐 말이 막혀도 괜찮아요. ‘뭐라고 말하지?’를 눌러 보세요.
            </p>
          </section>
        </main>
      )}
      {page === "session" && (
        <Conversation
          key={`${config.language}-${config.scenario}-${config.mode}`}
          config={config}
          onEnd={(m, d, s, incomplete) => void end(m, d, s, incomplete)}
        />
      )}
      {page === "review" && record && (
        <main className="review-page">
          <button className="back-link" onClick={() => navigate("history")}>
            <ChevronLeft size={18} />
            연습 기록
          </button>
          <section className="review-celebration">
            <div>
              <p className="eyebrow">EVERY WORD IS A LITTLE STEP</p>
              <h1 tabIndex={-1}>한마디 더, 한 걸음 더.</h1>
              <p>오늘 꺼낸 이야기를 함께 돌아볼까요?</p>
              <div className="session-tags">
                <span>{scenarioFor(record.config.scenario).title}</span>
                <span>
                  {languages[record.config.language].name} ·{" "}
                  {levels[record.config.level].name}
                </span>
                <span>
                  <Clock3 size={14} />
                  {formatTime(record.duration)}
                </span>
                {record.config.mode === "demo" && (
                  <span className="demo-tag">데모</span>
                )}
              </div>
            </div>
            <Mascot mood="encouraging" />
          </section>
          {record.incompleteTranscription && (
            <div className="inline-error" role="status">
              일부 음성의 전사를 끝내지 못했어요. 아래 복기는 기록된 문장만을
              기준으로 해요. 마지막 발화가 포함됐는지 대화 원문을 확인해 주세요.
            </div>
          )}
          {storageError && (
            <div className="inline-error" role="alert">
              {storageError}
              <button className="quiet-button" onClick={() => persist(record)}>
                저장 다시 시도
              </button>
            </div>
          )}
          {record.config.mode === "demo" && (
            <div className="demo-banner">
              <span className="pill">데모 복기</span>
              <span>
                직접 입력한 문장을 보여 드려요. 예시 규칙 외의 AI 교정·음성
                평가는 하지 않았어요.
              </span>
            </div>
          )}
          {record.config.mode === "live" && (
            <p className="audio-notice">
              발음 듣기는 기기 음성을 먼저 사용해요. 없거나 재생에 실패하면
              선택한 문장을 OpenAI로 보내 AI 음성을 만들어요.
            </p>
          )}
          {reviewLoading ? (
            <div className="review-loading">
              <Mascot mood="thinking" />
              <div>
                <h2>오늘의 한마디를 정리하고 있어요</h2>
                <p>모루가 실제로 남긴 문장을 차근차근 읽어 볼게요.</p>
                <LoaderCircle className="spin" />
              </div>
            </div>
          ) : record.reviewError || !record.review ? (
            <div className="inline-error" role="alert">
              <strong>복기를 아직 만들지 못했어요.</strong>
              {record.reviewError ||
                "이 세션의 복기가 아직 생성되지 않았어요. 아래 버튼으로 다시 만들 수 있어요."}
              <p>
                대화 원문은 기록에 남아 있어요. 실제 모드는 데모로 바뀌지
                않아요.
              </p>
              <button
                className="button secondary"
                onClick={() => void generateReview(record)}
              >
                복기 다시 만들기
              </button>
            </div>
          ) : (
            record.review && (
              <>
                <div className="review-summary">
                  <Heart size={21} />
                  <p>{record.review.summary}</p>
                </div>
                {record.review.insufficient && (
                  <p className="insufficient-note">
                    <Sprout size={18} />
                    평가할 발화가 충분하지 않아요. 평가를 채워 넣지 않고, 남긴
                    표현부터 살펴봐요.
                  </p>
                )}
                <div className="section-heading review-section-heading">
                  <h2>내가 말한 표현, 조금 더 자연스럽게</h2>
                  <span>{record.review.feedback.length}개의 표현</span>
                </div>
                <div className="feedback-list">
                  {record.review.feedback.map((f, i) => (
                    <article className="feedback-card" key={f.messageId}>
                      <div className="feedback-heading">
                        <span className="feedback-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="feedback-category">{f.category}</span>
                      </div>
                      <div className="comparison">
                        <div className="original-expression">
                          <span className="small-label">내가 말한 문장</span>
                          <p lang={record.config.language}>{f.original}</p>
                        </div>
                        <div className="improved-expression">
                          <span className="small-label">
                            {f.original === f.improved
                              ? "다시 말해 보기"
                              : "이렇게 말하면 더 자연스러워요"}
                          </span>
                          <p lang={record.config.language}>
                            <Highlighted
                              original={f.original}
                              improved={f.improved}
                            />
                          </p>
                          <button
                            className="text-audio"
                            onClick={() => play(f.improved, record.config)}
                            aria-label={`추천 문장 ${i + 1} 발음 듣기`}
                          >
                            <Volume2 size={17} />
                            발음 듣기
                          </button>
                        </div>
                      </div>
                      <div className="feedback-explanation">
                        <LightbulbIcon />
                        <p>{f.explanation}</p>
                      </div>
                    </article>
                  ))}
                </div>
                {record.review.feedback.length === 0 && (
                  <Empty
                    title={
                      record.review.insufficient
                        ? "평가할 발화가 충분하지 않아요"
                        : "추가 교정 제안은 없어요"
                    }
                  >
                    {record.review.insufficient
                      ? "남긴 문장은 아래 대화 원문에서 확인할 수 있어요. 다음에는 한마디 더 이어 볼까요?"
                      : "아래 대화 원문과 보조 평가를 보며 내가 말한 표현을 다시 연습해 보세요."}
                  </Empty>
                )}
                <section className="assessment">
                  <div>
                    <h2>살짝 살펴보는 말하기</h2>
                    <p>점수보다, 다음 한마디를 위한 참고예요.</p>
                  </div>
                  <div className="assessment-grid">
                    {(
                      [
                        { key: "delivery", label: "전달력" },
                        { key: "naturalness", label: "자연스러움" },
                        { key: "grammar", label: "문법" },
                        { key: "vocabulary", label: "어휘" },
                      ] as const
                    ).map((a) => (
                      <div key={a.key}>
                        <span>{a.label}</span>
                        <p>{record.review!.assessment[a.key]}</p>
                      </div>
                    ))}
                  </div>
                  <p className="assessment-note">
                    음성의 발음·억양을 채점하지 않아요. 실제 모드의 평가는 전사
                    텍스트를 바탕으로 해요.
                  </p>
                </section>
              </>
            )
          )}
          {audioNotice && (
            <p className="audio-notice" role="status">
              {audioNotice}
            </p>
          )}
          <details className="full-transcript">
            <summary>
              <BookOpen size={18} />
              대화 원문 전체 보기 <span>{record.messages.length}개 메시지</span>
            </summary>
            <div>
              {record.messages.length ? (
                record.messages.map((m) => (
                  <div key={m.id}>
                    <strong>{m.role === "user" ? "나" : "모루"}</strong>
                    <p lang={record.config.language}>{m.text}</p>
                  </div>
                ))
              ) : (
                <p>기록된 대화가 없어요.</p>
              )}
            </div>
          </details>
          <div className="review-actions">
            <button className="button primary" onClick={retry}>
              <RotateCcw size={20} />
              같은 설정으로 다시 연습
            </button>
            <button
              className="button secondary"
              onClick={() => navigate("home")}
            >
              아지트로 돌아가기
            </button>
          </div>
          <p className="privacy-note">
            <ShieldCheck size={14} />이 기기에 저장된 기록이에요 ·{" "}
            {dateLabel(record.startedAt)}
          </p>
        </main>
      )}
      {page === "history" && (
        <main className="standard-page history-page">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MY LITTLE COLLECTION</p>
              <h1 tabIndex={-1}>차곡차곡, 나의 이야기</h1>
              <p className="page-intro">
                어제의 한마디를 다시 꺼내 보면, 오늘은 조금 더 편해질 거예요.
              </p>
            </div>
            <span className="record-count">
              {records.length}
              <small>번의 대화</small>
            </span>
          </div>
          <div className="history-storage-note">
            <ShieldCheck size={20} />
            <div>
              <strong>이 기기, 이 브라우저에만 저장돼요.</strong>
              <p>
                계정 동기화는 없어요. 브라우저 데이터를 지우면 기록도 사라져요.
              </p>
            </div>
          </div>
          {storageError && (
            <p className="inline-error" role="alert">
              {storageError}
            </p>
          )}
          <div className="history-tabs" aria-label="기록 언어 필터">
            {(
              [
                { id: "all", name: "모든 이야기" },
                { id: "en", name: "영어" },
                { id: "ja", name: "일본어" },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={filter === f.id ? "selected" : ""}
                aria-pressed={filter === f.id}
              >
                {f.name}
              </button>
            ))}
          </div>
          {records.filter(
            (r) => filter === "all" || r.config.language === filter,
          ).length ? (
            recordList(
              records.filter(
                (r) => filter === "all" || r.config.language === filter,
              ),
            )
          ) : (
            <Empty
              title={
                records.length
                  ? "이 언어로 남긴 이야기는 아직 없어요"
                  : "우리의 첫 이야기를 기다리고 있어요"
              }
              action={
                <button
                  className="button primary"
                  onClick={() => prepare("free")}
                >
                  <Mic size={19} />첫 대화 시작하기
                </button>
              }
            >
              잘 정리된 문장보다, 직접 꺼내 본 한마디가 더 소중해요.
            </Empty>
          )}
        </main>
      )}
      <footer className="site-footer">
        <span>TalkSimul</span>
        <p>작은 대화가 자라는 곳.</p>
        <span className="footer-flower">✳</span>
        <small>MADE FOR YOUR LITTLE STEPS</small>
      </footer>
      {levelPicker && (
        <Modal
          title="내게 편한 속도로 이야기해요"
          onClose={() => setLevelPicker(false)}
        >
          <p className="modal-copy">
            테스트 없이 내가 직접 고르는 난이도예요. 다음 대화부터 적용돼요.
          </p>
          <div className="level-picker-list">
            {(Object.entries(levels) as [Level, (typeof levels)[Level]][]).map(
              ([key, l], i) => (
                <button
                  key={key}
                  className={config.level === key ? "selected" : ""}
                  onClick={() => {
                    setConfig((c) => ({ ...c, level: key }));
                    setLevelPicker(false);
                  }}
                >
                  <LevelSprouts count={i + 1} />
                  <span>
                    <strong>
                      {l.name} · {l.subtitle}
                    </strong>
                    <small>{l.description}</small>
                  </span>
                  {config.level === key && <Check size={20} />}
                </button>
              ),
            )}
          </div>
        </Modal>
      )}
      {settings && (
        <Modal
          title="연결 및 데이터 설정"
          onClose={() => setSettings(false)}
          wide
        >
          <div className="settings-status">
            <span
              className={`connection-light ${status?.configured && status.enabled ? "ready" : ""}`}
            />
            <div>
              <strong>
                {status?.configured && status.enabled
                  ? "실제 AI 연결 준비됨"
                  : "현재는 데모를 사용할 수 있어요"}
              </strong>
              <p>
                {status?.configured && status.enabled
                  ? "설정이 확인됐어요. 실제 연결은 대화 시작 후 확인할 수 있어요."
                  : "서버의 AI 연결이 준비되지 않았어요. 잠시 뒤 다시 확인해 주세요."}
              </p>
            </div>
          </div>
          {statusError && <p className="inline-error">{statusError}</p>}
          <div className="settings-instructions">
            <h3>실제 음성 대화를 시작하려면</h3>
            <ol>
              <li>
                Vercel 로그인 화면이 나타나면 허용된 Vercel 계정으로 로그인해요.
              </li>
              <li>언어와 대화 주제를 골라요.</li>
              <li>실제 AI 모드를 선택하고 음성·텍스트 전송 안내를 확인해요.</li>
              <li>대화를 시작하면 브라우저의 마이크 사용을 허용해 주세요.</li>
            </ol>
            <button
              className="button secondary"
              onClick={() => void refreshStatus()}
            >
              <RotateCcw size={17} />
              설정 상태 다시 확인
            </button>
          </div>
          <div className="data-facts">
            <h3>내 데이터는 어디에 있나요?</h3>
            <p>
              <ShieldCheck size={18} />
              원본 음성은 앱에서 저장하지 않아요.
            </p>
            <p>
              <BookOpen size={18} />
              대화 텍스트와 복기는 이 브라우저에 저장돼요. 연습 기록에서 개별
              삭제할 수 있어요.
            </p>
            <p>
              <Volume2 size={18} />
              데모의 발음은 기기 음성만 사용해요. 실제 모드에서는 기기 음성이
              없거나 실패하면 선택한 문장을 OpenAI로 보내 AI 음성을 만들어요.
            </p>
          </div>
        </Modal>
      )}
      {deleteId && (
        <Modal title="이 이야기를 지울까요?" onClose={() => setDeleteId(null)}>
          <p className="modal-copy">
            선택한 세션의 대화와 복기가 이 기기에서 삭제돼요. 삭제 후에는 되돌릴
            수 없어요.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteId(null)}
            >
              남겨 둘게요
            </button>
            <button
              className="button danger"
              onClick={() => {
                const result = deleteRecord(deleteId);
                if (!result.error) {
                  deletedRecords.current.add(deleteId);
                  if (reviewTarget.current === deleteId) {
                    reviewAbort.current?.abort();
                    setReviewLoading(false);
                  }
                }
                setRecords(result.records);
                setStorageError(result.error ?? "");
                setDeleteId(null);
              }}
            >
              기록 삭제
            </button>
          </div>
        </Modal>
      )}
      {leaveTo && (
        <Modal title="대화에서 나갈까요?" onClose={() => setLeaveTo(null)}>
          <p className="modal-copy">
            이 화면을 나가면 마이크와 연결이 종료돼요. 지금 대화를 복기에
            남기려면 ‘계속 이야기하기’를 누른 뒤 ‘대화 마치기’를 이용해 주세요.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setLeaveTo(null)}
            >
              계속 이야기하기
            </button>
            <button
              className="button primary"
              onClick={() => {
                stopSpeech();
                setPage(leaveTo);
                setLeaveTo(null);
              }}
            >
              저장하지 않고 나가기
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function LightbulbIcon() {
  return <Sparkles size={18} aria-hidden="true" />;
}
function Highlighted({
  original,
  improved,
}: {
  original: string;
  improved: string;
}) {
  if (original === improved) return <>{improved}</>;
  let start = 0;
  while (
    start < original.length &&
    start < improved.length &&
    original[start] === improved[start]
  )
    start++;
  let end = 0;
  while (
    end < original.length - start &&
    end < improved.length - start &&
    original[original.length - 1 - end] === improved[improved.length - 1 - end]
  )
    end++;
  return (
    <>
      {improved.slice(0, start)}
      <mark>
        {improved.slice(start, end ? improved.length - end : undefined)}
      </mark>
      {end ? improved.slice(-end) : ""}
    </>
  );
}
