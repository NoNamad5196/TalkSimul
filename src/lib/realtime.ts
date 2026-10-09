import type {
  ConversationState,
  Message,
  SessionConfig,
} from "../../shared/types";

export interface RealtimeCallbacks {
  onState: (state: ConversationState) => void;
  onMessage: (message: Message) => void;
  onError: (message: string) => void;
}

export interface RealtimeFinishResult {
  incompleteTranscription: boolean;
}

interface RealtimeEvent {
  type: string;
  item_id?: string;
  previous_item_id?: string | null;
  item?: { id?: string; role?: string; content?: { type?: string }[] };
  content_index?: number;
  transcript?: string;
  text?: string;
  response_id?: string;
  response?: { id?: string; status?: string };
  error?: { code?: string; event_id?: string };
}

const CONNECT_TIMEOUT = 30_000;
const RESPONSE_TIMEOUT = 60_000;
const DISCONNECT_TIMEOUT = 8_000;
const TRANSCRIPT_DRAIN_TIMEOUT = 1_800;

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "마이크 권한이 꺼져 있어요. 브라우저의 사이트 설정에서 마이크를 허용한 뒤 다시 시작해 주세요.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "연결된 마이크를 찾지 못했어요. 마이크를 연결한 뒤 다시 시작해 주세요.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "마이크를 사용할 수 없어요. 다른 앱의 마이크 사용과 장치 연결을 확인해 주세요.";
  }
  return "음성 연결을 시작하지 못했어요. 마이크와 네트워크를 확인한 뒤 다시 시작해 주세요.";
}

/**
 * OpenAI Realtime WebRTC transport. The UI owns consent and must call connect
 * only from an explicit start action. No audio recording, storage, or API key.
 * See https://developers.openai.com/api/docs/guides/realtime-conversations
 */
export class RealtimeClient {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private remoteTracks = new Set<MediaStreamTrack>();
  private controller: AbortController | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private settleConnect: (() => void) | null = null;
  private settleFinish: ((result: RealtimeFinishResult) => void) | null = null;
  private finishPromise: Promise<RealtimeFinishResult> | null = null;
  private finishing = false;
  private finishCommitSent = false;
  private generation = 0;
  private closed = true;
  private ready = false;
  private muted = false;
  private paused = false;
  private userSpeaking = false;
  private responsePending = false;
  private responseId: string | null = null;
  private outputPlaying = false;
  private seenMessages = new Set<string>();
  private cancelledResponses = new Set<string>();
  private itemTimestamps = new Map<string, number>();
  private pendingTranscripts = new Set<string>();
  private settledTranscripts = new Set<string>();
  private activeSpeechItem: string | null = null;
  private awaitingCommit = false;
  private transcriptionFailed = false;
  private state: ConversationState = "idle";

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get connected(): boolean {
    return this.ready && !this.closed;
  }

  /** Settles on channel open, handled failure, or close; errors use onError. */
  async connect(config: SessionConfig): Promise<void> {
    this.release();
    this.closed = false;
    this.muted = false;
    this.paused = false;
    this.seenMessages.clear();
    this.cancelledResponses.clear();
    this.itemTimestamps.clear();
    this.pendingTranscripts.clear();
    this.settledTranscripts.clear();
    this.transcriptionFailed = false;
    const generation = this.generation;
    this.setState("connecting");
    const settled = new Promise<void>((resolve) => {
      this.settleConnect = resolve;
    });
    this.connectTimer = setTimeout(() => {
      if (this.isCurrent(generation))
        this.fail(
          "음성 연결 시간이 초과됐어요. 마이크 권한과 네트워크를 확인한 뒤 다시 시작해 주세요.",
        );
    }, CONNECT_TIMEOUT);
    void this.establish(config, generation).catch((error: unknown) => {
      if (this.isCurrent(generation)) this.fail(microphoneError(error));
    });
    await settled;
  }

  private async establish(
    config: SessionConfig,
    generation: number,
  ): Promise<void> {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      this.fail(
        "이 브라우저는 실시간 음성을 지원하지 않아요. 최신 Chrome 또는 Edge에서 localhost로 열어 주세요.",
      );
      return;
    }
    // Permission prompts cannot be aborted. A stream arriving after close is
    // stopped before it can be attached to a peer connection.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!this.isCurrent(generation)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.microphone = stream;
    if (!stream.getAudioTracks().length) {
      this.fail(
        "마이크에서 오디오를 받을 수 없어요. 장치 연결을 확인해 주세요.",
      );
      return;
    }
    const peer = new RTCPeerConnection();
    this.peer = peer;
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.muted = this.paused;
    this.audio = audio;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.muted && !this.paused;
      track.onended = () => {
        if (this.isCurrent(generation))
          this.fail(
            "마이크 연결이 끊어졌어요. 장치를 다시 연결한 뒤 시작해 주세요.",
          );
      };
      peer.addTrack(track, stream);
    }
    peer.ontrack = (event) => {
      if (!this.isCurrent(generation) || this.finishing) {
        event.track.stop();
        return;
      }
      this.remoteTracks.add(event.track);
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.playAudio();
    };
    peer.onconnectionstatechange = () => {
      if (!this.isCurrent(generation)) return;
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed"
      ) {
        this.fail(
          "음성 연결이 끊어졌어요. 네트워크를 확인한 뒤 다시 시작해 주세요.",
        );
      } else if (peer.connectionState === "disconnected") {
        if (this.finishing) {
          this.close();
          return;
        }
        if (!this.disconnectTimer)
          this.disconnectTimer = setTimeout(() => {
            if (this.isCurrent(generation))
              this.fail("음성 연결을 복구하지 못했어요. 다시 시작해 주세요.");
          }, DISCONNECT_TIMEOUT);
      } else if (peer.connectionState === "connected") {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = undefined;
      }
    };
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = ({ data }) => {
      if (!this.isCurrent(generation) || typeof data !== "string") return;
      try {
        const event: unknown = JSON.parse(data);
        if (
          event &&
          typeof event === "object" &&
          "type" in event &&
          typeof event.type === "string"
        ) {
          this.receive(event as RealtimeEvent);
        }
      } catch {
        /* Malformed non-event data is not a transcript. */
      }
    };
    channel.onerror = () => {
      if (this.isCurrent(generation))
        this.fail("음성 대화 연결에 문제가 생겼어요. 다시 시작해 주세요.");
    };
    channel.onclose = () => {
      if (this.isCurrent(generation))
        this.fail("음성 대화 연결이 종료됐어요. 다시 시작해 주세요.");
    };
    channel.onopen = () => {
      if (!this.isCurrent(generation)) return;
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.ready = true;
      this.restingState();
      if (!this.paused) this.createResponse();
      this.settleConnect?.();
      this.settleConnect = null;
    };
    const offer = await peer.createOffer();
    if (!this.isCurrent(generation)) return;
    await peer.setLocalDescription(offer);
    if (!this.isCurrent(generation)) return;
    const controller = new AbortController();
    this.controller = controller;
    const response = await fetch("/api/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, config }),
      signal: controller.signal,
    });
    if (!this.isCurrent(generation)) return;
    const result: unknown = await response.json();
    if (!this.isCurrent(generation)) return;
    if (!response.ok) {
      const error =
        result && typeof result === "object" && "error" in result
          ? result.error
          : null;
      this.fail(
        typeof error === "string"
          ? error
          : "AI 서버에 연결하지 못했어요. 로컬 API 설정을 확인해 주세요.",
      );
      return;
    }
    if (
      !result ||
      typeof result !== "object" ||
      !("sdp" in result) ||
      typeof result.sdp !== "string" ||
      !result.sdp.trim()
    ) {
      this.fail("AI 서버의 연결 응답을 확인하지 못했어요. 다시 시작해 주세요.");
      return;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
  }

  setMuted(muted: boolean): void {
    if (this.finishing) return;
    this.muted = muted;
    this.updateMicrophone();
    if (
      this.connected &&
      !this.outputPlaying &&
      !this.responsePending &&
      !this.responseId
    )
      this.restingState();
  }

  /** Pause both directions before playing a hint with a separate speech engine. */
  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.updateMicrophone();
    if (this.audio) this.audio.muted = true;
    this.interruptResponse();
    this.send({ type: "input_audio_buffer.clear" });
    this.userSpeaking = false;
    this.restingState();
  }

  resume(): void {
    if (this.closed || this.finishing || !this.paused) return;
    this.send({ type: "input_audio_buffer.clear" });
    this.paused = false;
    if (this.audio) {
      this.audio.muted = false;
      if (this.audio.srcObject) this.playAudio();
    }
    this.updateMicrophone();
    this.restingState();
  }

  /** Never call for displaying a hint. Only actual submitted user input. */
  sendText(text: string): boolean {
    const value = text.trim();
    if (!value || this.finishing || this.paused || !this.connected)
      return false;
    if (value.length > 4_000) {
      this.callbacks.onError(
        "한 번에 4,000자까지 보낼 수 있어요. 문장을 나누어 주세요.",
      );
      return false;
    }
    if (this.responseId || this.responsePending) {
      this.callbacks.onError(
        "친구가 답변을 준비하고 있어요. 답변이 끝나면 다시 보내 주세요.",
      );
      return false;
    }
    if (this.outputPlaying) this.interruptResponse();
    const id = `user_${crypto.randomUUID().replaceAll("-", "")}`;
    if (
      !this.send({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: value }],
        },
      })
    )
      return false;
    this.emitMessage(id, "user", value, "typed");
    this.createResponse();
    return true;
  }

  /**
   * End user capture immediately, then give already-sent audio a bounded window
   * to finish transcription. The caller should await this before taking the
   * review snapshot. close() still aborts immediately (including this drain).
   */
  finish(): Promise<RealtimeFinishResult> {
    if (this.finishPromise) return this.finishPromise;
    if (
      !this.connected ||
      this.channel?.readyState !== "open" ||
      ["disconnected", "failed", "closed"].includes(
        this.peer?.connectionState ?? "closed",
      )
    ) {
      const result = this.finishResult();
      this.close();
      return Promise.resolve(result);
    }
    this.finishing = true;
    this.paused = true;
    this.stopMicrophone();
    if (this.audio) {
      this.audio.muted = true;
      this.audio.pause();
    }
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    const pending = new Promise<RealtimeFinishResult>((resolve) => {
      this.settleFinish = resolve;
    });
    this.finishPromise = pending;
    this.finishTimer = setTimeout(() => {
      if (this.pendingTranscripts.size || this.awaitingCommit) {
        this.callbacks.onError(
          "마지막 발화의 전사가 제시간에 도착하지 않았어요. 도착한 문장만 복기에 포함했어요.",
        );
      }
      this.close();
    }, TRANSCRIPT_DRAIN_TIMEOUT);
    this.interruptResponse();
    // A manually committed buffer requests transcription, not a new response.
    // Do not clear the input buffer here: it may contain the final utterance.
    if (this.userSpeaking || this.awaitingCommit)
      this.finishCommitSent = this.send({ type: "input_audio_buffer.commit" });
    this.userSpeaking = false;
    if (!this.closed) this.restingState();
    return pending;
  }

  close(): void {
    this.release();
    this.setState("ended");
  }

  private receive(event: RealtimeEvent): void {
    this.trackConversationItem(event);
    const responseId = event.response_id ?? event.response?.id;
    // A response's final events can arrive after a hint pause and the next turn.
    // They must not overwrite the new turn's state or restore cancelled output.
    if (responseId && this.cancelledResponses.has(responseId)) return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (this.paused || this.muted) break;
        this.userSpeaking = true;
        clearTimeout(this.responseTimer);
        this.setState("user-speaking");
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        if (!this.paused) {
          this.setState("thinking");
          this.watchResponse();
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.emitMessage(event.item_id, "user", event.transcript, "voice");
        this.settleTranscript(event.item_id);
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.transcriptionFailed = true;
        this.callbacks.onError(
          this.finishing
            ? "마지막 발화를 글로 옮기지 못했어요. 이 발화는 복기에 포함되지 않아요."
            : "방금 말한 내용을 글로 옮기지 못했어요. 이 발화는 복기에 포함되지 않아요. 다시 말해 주세요.",
        );
        this.settleTranscript(event.item_id);
        this.restingState();
        break;
      case "response.created":
        this.responsePending = false;
        this.responseId = event.response?.id ?? null;
        if (this.paused) this.interruptResponse();
        else {
          this.setState("thinking");
          this.watchResponse();
        }
        break;
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
        if (!this.paused) this.watchResponse();
        break;
      case "output_audio_buffer.started":
        this.outputPlaying = true;
        if (this.paused) {
          this.interruptResponse();
          break;
        }
        this.setState("speaking");
        this.watchResponse();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.outputPlaying = false;
        if (!this.responseId && !this.responsePending) {
          clearTimeout(this.responseTimer);
          this.restingState();
        }
        break;
      case "response.output_audio_transcript.done":
        if (!this.paused)
          this.emitMessage(
            event.item_id,
            "assistant",
            event.transcript,
            "voice",
          );
        break;
      case "response.output_text.done":
        if (!this.paused)
          this.emitMessage(event.item_id, "assistant", event.text, "typed");
        break;
      case "response.done":
        if (
          this.responseId &&
          event.response?.id &&
          this.responseId !== event.response.id
        )
          break;
        this.responseId = null;
        this.responsePending = false;
        if (
          event.response?.status === "failed" ||
          event.response?.status === "incomplete"
        ) {
          this.callbacks.onError(
            "AI 답변을 끝까지 받지 못했어요. 잠시 후 다시 말하거나 메시지를 보내 주세요.",
          );
        }
        // Generation ends before the WebRTC output buffer has finished playing.
        if (!this.outputPlaying) {
          clearTimeout(this.responseTimer);
          this.restingState();
        }
        break;
      case "error":
        // A cancel can race with a natural response completion; it is harmless.
        if (event.error?.code === "response_cancel_not_active") break;
        if (this.finishing) break;
        this.responsePending = false;
        this.responseId = null;
        clearTimeout(this.responseTimer);
        this.callbacks.onError(
          "AI가 이번 요청을 처리하지 못했어요. 다시 말해 주세요. 반복되면 대화를 다시 시작해 주세요.",
        );
        if (!this.outputPlaying) this.restingState();
        break;
    }
  }

  private emitMessage(
    id: string | undefined,
    role: Message["role"],
    text: string | undefined,
    source: Message["source"],
  ): void {
    if (!text?.trim()) return;
    const messageId = id ?? `${role}_${crypto.randomUUID()}`;
    const key = `${role}:${messageId}`;
    if (this.seenMessages.has(key)) return;
    this.seenMessages.add(key);
    this.callbacks.onMessage({
      id: messageId,
      role,
      text: text.trim(),
      source,
      timestamp: this.reserveItem(messageId),
    });
  }

  /** Reserve chronology on creation/commit, independently of ASR arrival time. */
  private trackConversationItem(event: RealtimeEvent): void {
    const id = event.item_id ?? event.item?.id;
    if (event.type === "input_audio_buffer.speech_started") {
      if (this.paused && !this.finishing) return;
      this.awaitingCommit = true;
      this.activeSpeechItem = id ?? null;
      if (id) {
        this.reserveItem(id);
        this.pendingTranscripts.add(id);
      }
      if (this.finishing && !this.finishCommitSent)
        this.finishCommitSent = this.send({
          type: "input_audio_buffer.commit",
        });
    } else if (event.type === "input_audio_buffer.committed") {
      if (id) {
        // Manual commit during active VAD can assign a different item ID.
        if (
          this.awaitingCommit &&
          this.activeSpeechItem &&
          this.activeSpeechItem !== id
        ) {
          this.pendingTranscripts.delete(this.activeSpeechItem);
          const timestamp = this.itemTimestamps.get(this.activeSpeechItem);
          if (timestamp !== undefined && !this.itemTimestamps.has(id))
            this.itemTimestamps.set(id, timestamp);
          this.itemTimestamps.delete(this.activeSpeechItem);
        }
        this.reserveItem(id, event.previous_item_id);
        if (!this.settledTranscripts.has(id)) this.pendingTranscripts.add(id);
      }
      this.awaitingCommit = false;
      this.activeSpeechItem = null;
    } else if (
      [
        "conversation.item.added",
        "conversation.item.created",
        "conversation.item.done",
        "response.output_item.added",
      ].includes(event.type)
    ) {
      if (id) {
        this.reserveItem(id, event.previous_item_id);
        if (
          event.item?.role === "user" &&
          event.item.content?.some((part) => part.type === "input_audio") &&
          !this.settledTranscripts.has(id)
        ) {
          this.pendingTranscripts.add(id);
        }
      }
    } else if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      id
    ) {
      this.reserveItem(id);
      if (!this.settledTranscripts.has(id)) this.pendingTranscripts.add(id);
    } else if (event.type === "input_audio_buffer.cleared") {
      if (this.awaitingCommit && this.activeSpeechItem)
        this.pendingTranscripts.delete(this.activeSpeechItem);
      this.awaitingCommit = false;
      this.activeSpeechItem = null;
    }
  }

  private reserveItem(id: string, previousId?: string | null): number {
    const existing = this.itemTimestamps.get(id);
    if (existing !== undefined) {
      // A speech-start event may precede creation of its predecessor. Reserve
      // that missing predecessor immediately before this already-known item.
      if (
        previousId &&
        previousId !== id &&
        !this.itemTimestamps.has(previousId)
      ) {
        const earlier = [...this.itemTimestamps.values()].filter(
          (value) => value < existing,
        );
        const previous = earlier.length ? Math.max(...earlier) : existing - 2;
        this.itemTimestamps.set(previousId, (previous + existing) / 2);
      }
      if (
        !this.seenMessages.has(`user:${id}`) &&
        !this.seenMessages.has(`assistant:${id}`)
      ) {
        const others = [...this.itemTimestamps.entries()]
          .filter(([key]) => key !== id)
          .map(([, value]) => value);
        const previous = previousId
          ? this.itemTimestamps.get(previousId)
          : undefined;
        const next =
          previous === undefined
            ? undefined
            : others
                .filter((value) => value > previous)
                .sort((a, b) => a - b)[0];
        if (
          previous !== undefined &&
          (existing <= previous || (next !== undefined && next < existing))
        ) {
          const corrected =
            next === undefined
              ? Math.max(Date.now(), previous + 1)
              : (previous + next) / 2;
          this.itemTimestamps.set(id, corrected);
          return corrected;
        }
        if (previousId === null && others.some((value) => value < existing)) {
          const corrected = Math.min(...others) - 1;
          this.itemTimestamps.set(id, corrected);
          return corrected;
        }
      }
      return existing;
    }
    let timestamp: number;
    if (previousId && previousId !== id) {
      const previous = this.reserveItem(previousId);
      const later = [...this.itemTimestamps.values()].filter(
        (value) => value > previous,
      );
      timestamp = later.length
        ? (previous + Math.min(...later)) / 2
        : Math.max(Date.now(), previous + 1);
    } else {
      const values = [...this.itemTimestamps.values()];
      timestamp =
        previousId === null && values.length
          ? Math.min(...values) - 1
          : Math.max(Date.now(), values.length ? Math.max(...values) + 1 : 0);
    }
    this.itemTimestamps.set(id, timestamp);
    return timestamp;
  }

  private settleTranscript(id: string | undefined): void {
    if (id) {
      this.pendingTranscripts.delete(id);
      this.settledTranscripts.add(id);
      if (id === this.activeSpeechItem) {
        this.awaitingCommit = false;
        this.activeSpeechItem = null;
      }
    }
    if (this.finishing && !this.pendingTranscripts.size && !this.awaitingCommit)
      this.close();
  }

  private createResponse(): void {
    if (this.finishing) return;
    if (this.send({ type: "response.create" })) {
      this.responsePending = true;
      this.setState("thinking");
      this.watchResponse();
    }
  }

  private interruptResponse(): void {
    if (this.responseId) this.cancelledResponses.add(this.responseId);
    if (this.responseId || this.responsePending)
      this.send({
        type: "response.cancel",
        ...(this.responseId ? { response_id: this.responseId } : {}),
      });
    if (this.outputPlaying || this.responseId || this.responsePending)
      this.send({ type: "output_audio_buffer.clear" });
    this.responseId = null;
    this.responsePending = false;
    this.outputPlaying = false;
    clearTimeout(this.responseTimer);
    this.responseTimer = undefined;
  }

  private watchResponse(): void {
    clearTimeout(this.responseTimer);
    const generation = this.generation;
    this.responseTimer = setTimeout(() => {
      if (!this.isCurrent(generation) || this.paused) return;
      this.interruptResponse();
      this.callbacks.onError(
        "답변이 오래 지연되어 멈췄어요. 다시 말하거나 대화를 다시 시작해 주세요.",
      );
      this.restingState();
    }, RESPONSE_TIMEOUT);
  }

  private updateMicrophone(): void {
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted && !this.paused;
    });
  }

  private playAudio(): void {
    if (this.finishing) return;
    const generation = this.generation;
    void this.audio?.play().catch(() => {
      if (this.isCurrent(generation) && !this.paused) {
        this.fail(
          "브라우저가 AI 음성 재생을 막았어요. 사이트의 소리 재생을 허용한 뒤 다시 시작해 주세요.",
        );
      }
    });
  }

  private restingState(): void {
    if (this.closed) return;
    this.setState(
      this.paused || this.muted
        ? "muted"
        : this.userSpeaking
          ? "user-speaking"
          : "listening",
    );
  }

  private send(event: Record<string, unknown>): boolean {
    if (this.closed || this.channel?.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      this.fail("대화 메시지를 보내지 못했어요. 연결을 다시 시작해 주세요.");
      return false;
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }

  private setState(state: ConversationState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }

  private fail(message: string): void {
    if (this.finishing) {
      this.close();
      return;
    }
    this.release();
    this.setState("error");
    this.callbacks.onError(message);
  }

  private release(): void {
    const finishResult = this.finishResult();
    this.closed = true;
    this.ready = false;
    this.generation++;
    clearTimeout(this.connectTimer);
    clearTimeout(this.responseTimer);
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.finishTimer);
    this.connectTimer =
      this.responseTimer =
      this.disconnectTimer =
      this.finishTimer =
        undefined;
    this.controller?.abort();
    this.controller = null;
    this.settleConnect?.();
    this.settleConnect = null;
    this.stopMicrophone();
    this.remoteTracks.forEach((track) => track.stop());
    this.remoteTracks.clear();
    if (this.channel) {
      this.channel.onopen =
        this.channel.onmessage =
        this.channel.onclose =
        this.channel.onerror =
          null;
      this.channel.close();
      this.channel = null;
    }
    if (this.peer) {
      this.peer.ontrack = this.peer.onconnectionstatechange = null;
      this.peer.close();
      this.peer = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.responseId = null;
    this.responsePending = this.outputPlaying = this.userSpeaking = false;
    this.awaitingCommit = false;
    this.activeSpeechItem = null;
    this.finishing = false;
    this.finishCommitSent = false;
    this.settleFinish?.(finishResult);
    this.settleFinish = null;
    this.finishPromise = null;
  }

  private finishResult(): RealtimeFinishResult {
    return {
      incompleteTranscription:
        this.transcriptionFailed ||
        this.pendingTranscripts.size > 0 ||
        this.awaitingCommit,
    };
  }

  private stopMicrophone(): void {
    this.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.enabled = false;
      track.stop();
    });
    this.microphone = null;
  }
}
