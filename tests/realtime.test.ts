import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient } from "../src/lib/realtime";
import type { Message, SessionConfig } from "../shared/types";

const config: SessionConfig = {
  language: "ja",
  level: "beginner",
  scenario: "cafe",
  mode: "live",
};
const makeTrack = () => ({
  enabled: true,
  stop: vi.fn(),
  onended: null as (() => void) | null,
});
const makeStream = () => {
  const track = makeTrack();
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

class MockChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.();
  });
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  event(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  sentTypes() {
    return this.send.mock.calls.map(([data]) => JSON.parse(data).type);
  }
}
class MockPeer {
  static instances: MockPeer[] = [];
  channel = new MockChannel();
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  ontrack:
    | ((event: {
        track: ReturnType<typeof makeTrack>;
        streams: unknown[];
      }) => void)
    | null = null;
  constructor() {
    MockPeer.instances.push(this);
  }
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "mock-offer" }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  state(value: string) {
    this.connectionState = value;
    this.onconnectionstatechange?.();
  }
}
class MockAudio {
  static instances: MockAudio[] = [];
  static rejectPlayback = false;
  autoplay = false;
  muted = false;
  srcObject: unknown = null;
  setAttribute = vi.fn();
  play = vi.fn(async () => {
    if (MockAudio.rejectPlayback) throw new Error("NotAllowedError");
  });
  pause = vi.fn();
  constructor() {
    MockAudio.instances.push(this);
  }
}

describe("Realtime browser transport (mocked, no microphone or paid API)", () => {
  let stream: ReturnType<typeof makeStream>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let callbacks: {
    onState: ReturnType<typeof vi.fn>;
    onMessage: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };
  let client: RealtimeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockPeer.instances = [];
    MockAudio.instances = [];
    MockAudio.rejectPlayback = false;
    stream = makeStream();
    getUserMedia = vi.fn().mockResolvedValue(stream);
    fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ sdp: "mock-answer" }),
      });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("RTCPeerConnection", MockPeer);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", fetchMock);
    callbacks = { onState: vi.fn(), onMessage: vi.fn(), onError: vi.fn() };
    client = new RealtimeClient(callbacks);
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connect() {
    const pending = client.connect(config);
    await flush();
    const peer = MockPeer.instances.at(-1)!;
    peer.channel.open();
    await pending;
    return { peer, channel: peer.channel, audio: MockAudio.instances.at(-1)! };
  }

  it("does not activate the microphone before explicit connect; sends selected config only to local server", async () => {
    expect(getUserMedia).not.toHaveBeenCalled();
    const { channel } = await connect();
    expect(client.connected).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/realtime");
    expect(JSON.parse(options.body)).toEqual({ sdp: "mock-offer", config });
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    expect(channel.sentTypes()).toEqual(["response.create"]);
    expect(callbacks.onState).toHaveBeenLastCalledWith("thinking");
  });

  it.each(["NotAllowedError", "NotFoundError", "NotReadableError"])(
    "handles microphone %s without starting a peer or requesting AI",
    async (name) => {
      getUserMedia.mockRejectedValue(Object.assign(new Error(), { name }));
      await client.connect(config);
      expect(client.connected).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(MockPeer.instances).toHaveLength(0);
      expect(callbacks.onState).toHaveBeenLastCalledWith("error");
      expect(callbacks.onError).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops a microphone arriving after close without opening a connection", async () => {
    const late = deferred<typeof stream>();
    getUserMedia.mockReturnValue(late.promise);
    const pending = client.connect(config);
    client.close();
    await pending;
    late.resolve(stream);
    await flush();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockPeer.instances).toHaveLength(0);
    expect(callbacks.onState).toHaveBeenLastCalledWith("ended");
  });

  it("does not let an old permission result contaminate a restarted session", async () => {
    const old = deferred<typeof stream>();
    const oldStream = makeStream();
    getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(stream);
    const first = client.connect(config);
    const { peer } = await connect();
    old.resolve(oldStream);
    await first;
    await flush();
    expect(oldStream.track.stop).toHaveBeenCalledOnce();
    expect(stream.track.stop).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    expect(client.connected).toBe(true);
  });

  it("aborts an in-flight SDP request and ignores its late answer after close", async () => {
    const answer = deferred<{
      ok: boolean;
      json: () => Promise<{ sdp: string }>;
    }>();
    fetchMock.mockReturnValue(answer.promise);
    const pending = client.connect(config);
    await flush();
    const peer = MockPeer.instances[0];
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
    client.close();
    await pending;
    expect(signal.aborted).toBe(true);
    answer.resolve({ ok: true, json: async () => ({ sdp: "late-answer" }) });
    await flush();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("synchronously releases tracks, output audio, handlers, channel, peer and every timer", async () => {
    const { peer, channel, audio } = await connect();
    const remote = makeTrack();
    peer.ontrack?.({ track: remote, streams: [{ remote: true }] });
    const oldHandler = channel.onmessage;
    client.close();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(remote.stop).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.srcObject).toBeNull();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    oldHandler?.({
      data: JSON.stringify({ type: "response.output_text.done", text: "late" }),
    });
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    client.close();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it("pauses both audio directions and response generation, then restores the intended mute setting", async () => {
    const { channel, audio } = await connect();
    channel.event({ type: "response.created", response: { id: "response-1" } });
    channel.event({ type: "output_audio_buffer.started" });
    client.setMuted(true);
    client.pause();
    expect(audio.muted).toBe(true);
    expect(stream.track.enabled).toBe(false);
    expect(channel.sentTypes().slice(-3)).toEqual([
      "response.cancel",
      "output_audio_buffer.clear",
      "input_audio_buffer.clear",
    ]);
    expect(callbacks.onState).toHaveBeenLastCalledWith("muted");
    expect(client.sendText("This displayed hint is not speech")).toBe(false);
    client.resume();
    expect(audio.muted).toBe(false);
    expect(stream.track.enabled).toBe(false);
    client.setMuted(false);
    expect(stream.track.enabled).toBe(true);
    expect(callbacks.onMessage).not.toHaveBeenCalled();
  });

  it("cancels a response that arrives while hint playback is already paused", async () => {
    const { channel } = await connect();
    client.pause();
    channel.send.mockClear();
    channel.event({ type: "response.created", response: { id: "late" } });
    expect(channel.sentTypes()).toEqual([
      "response.cancel",
      "output_audio_buffer.clear",
    ]);
    channel.event({ type: "output_audio_buffer.started" });
    expect(channel.sentTypes().at(-1)).toBe("output_audio_buffer.clear");
    expect(callbacks.onState).toHaveBeenLastCalledWith("muted");
  });

  it("uses only actual transcript events, ignores empty messages, and deduplicates event redelivery", async () => {
    const { channel } = await connect();
    const event = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "  コーヒーをください。  ",
    };
    channel.event(event);
    channel.event(event);
    channel.event({ ...event, item_id: "empty", transcript: "  " });
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      transcript: "ホットですか？",
    });
    expect(callbacks.onMessage).toHaveBeenCalledTimes(2);
    expect(callbacks.onMessage.mock.calls[0][0]).toMatchObject({
      id: "u1",
      role: "user",
      text: "コーヒーをください。",
      source: "voice",
    });
    expect(callbacks.onMessage.mock.calls[1][0]).toMatchObject({
      role: "assistant",
      text: "ホットですか？",
    });
  });

  it("does not let late cancelled output overwrite a resumed turn", async () => {
    const { channel } = await connect();
    channel.event({ type: "response.created", response: { id: "cancelled" } });
    client.pause();
    client.resume();
    expect(client.sendText("A new thought")).toBe(true);
    channel.event({
      type: "response.done",
      response: { id: "cancelled", status: "cancelled" },
    });
    expect(callbacks.onState).toHaveBeenLastCalledWith("thinking");
    channel.event({
      type: "response.output_audio_transcript.done",
      response_id: "cancelled",
      item_id: "old",
      transcript: "old unheard output",
    });
    expect(callbacks.onMessage).toHaveBeenCalledOnce();
    expect(client.sendText("Still generating")).toBe(false);
  });

  it("keeps the speaking state until output playback ends, even after generation is done", async () => {
    const { channel } = await connect();
    channel.event({ type: "response.created", response: { id: "r1" } });
    channel.event({ type: "output_audio_buffer.started", response_id: "r1" });
    channel.event({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    expect(callbacks.onState).toHaveBeenLastCalledWith("speaking");
    channel.event({ type: "output_audio_buffer.stopped", response_id: "r1" });
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");
  });

  it("sends typed messages through conversation.item.create and records only successful submissions", async () => {
    const { channel } = await connect();
    expect(client.sendText("while generating")).toBe(false);
    channel.event({ type: "response.done", response: { status: "completed" } });
    expect(client.sendText("   ")).toBe(false);
    expect(client.sendText("x".repeat(4_001))).toBe(false);
    expect(client.sendText("  I would like tea. ")).toBe(true);
    const request = JSON.parse(channel.send.mock.calls.at(-2)![0]);
    expect(request).toMatchObject({
      type: "conversation.item.create",
      item: {
        role: "user",
        content: [{ type: "input_text", text: "I would like tea." }],
      },
    });
    expect(callbacks.onMessage).toHaveBeenCalledOnce();
    expect(callbacks.onMessage.mock.calls[0][0]).toMatchObject({
      text: "I would like tea.",
      source: "typed",
    });
  });

  it("reports response failure without leaving the conversation stuck in thinking", async () => {
    const { channel } = await connect();
    channel.event({ type: "response.done", response: { status: "failed" } });
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");
    expect(client.connected).toBe(true);
    expect(client.sendText("Try again")).toBe(true);
  });

  it("times out an unresponsive answer and allows another turn", async () => {
    const { channel } = await connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("listening");
    expect(channel.sentTypes()).toContain("response.cancel");
    expect(client.sendText("Hello again")).toBe(true);
  });

  it("times out unresolved permission and disposes a subsequently granted microphone", async () => {
    const late = deferred<typeof stream>();
    getUserMedia.mockReturnValue(late.promise);
    const pending = client.connect(config);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(callbacks.onState).toHaveBeenLastCalledWith("error");
    late.resolve(stream);
    await flush();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a brief network interruption, but tears down a persistent disconnect", async () => {
    const { peer } = await connect();
    peer.state("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    peer.state("connected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(client.connected).toBe(true);
    peer.state("disconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(client.connected).toBe(false);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("error");
  });

  it("reports playback rejection and closes the microphone rather than silently appearing to work", async () => {
    const { peer } = await connect();
    MockAudio.rejectPlayback = true;
    peer.ontrack?.({ track: makeTrack(), streams: [{}] });
    await flush();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining("음성 재생"),
    );
    expect(client.connected).toBe(false);
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it("reserves conversation order before delayed user transcriptions arrive", async () => {
    const { channel } = await connect();
    channel.event({
      type: "conversation.item.added",
      previous_item_id: null,
      item: { id: "greeting", role: "assistant" },
    });
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "greeting",
      transcript: "Hello!",
    });
    channel.event({
      type: "input_audio_buffer.committed",
      item_id: "u1",
      previous_item_id: "greeting",
    });
    channel.event({
      type: "conversation.item.added",
      previous_item_id: "u1",
      item: { id: "a1", role: "assistant" },
    });
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      transcript: "Tea or coffee?",
    });
    channel.event({
      type: "input_audio_buffer.committed",
      item_id: "u2",
      previous_item_id: "a1",
    });
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u2",
      transcript: "Tea, please.",
    });
    await vi.advanceTimersByTimeAsync(400);
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "I would like a drink.",
    });
    const messages = callbacks.onMessage.mock.calls.map(
      ([message]) => message as Message,
    );
    expect(messages.map((message) => message.id)).toEqual([
      "greeting",
      "a1",
      "u2",
      "u1",
    ]);
    expect(
      messages
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((message) => message.id),
    ).toEqual(["greeting", "u1", "a1", "u2"]);
    expect(new Set(messages.map((message) => message.timestamp)).size).toBe(4);
  });

  it("reserves a predecessor placeholder when its item-created event arrives later", async () => {
    const { channel } = await connect();
    channel.event({
      type: "conversation.item.added",
      previous_item_id: "user",
      item: { id: "answer", role: "assistant" },
    });
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "answer",
      transcript: "Of course.",
    });
    channel.event({
      type: "input_audio_buffer.committed",
      previous_item_id: null,
      item_id: "user",
    });
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user",
      transcript: "Could I have tea?",
    });
    const [answer, user] = callbacks.onMessage.mock.calls.map(
      ([message]) => message as Message,
    );
    expect(user.timestamp).toBeLessThan(answer.timestamp);
  });

  it("reconciles speech-start ordering with the committed conversation predecessor", async () => {
    const { channel } = await connect();
    channel.event({
      type: "input_audio_buffer.speech_started",
      item_id: "user",
    });
    channel.event({
      type: "conversation.item.added",
      item: { id: "assistant", role: "assistant" },
    });
    channel.event({
      type: "input_audio_buffer.committed",
      previous_item_id: "assistant",
      item_id: "user",
    });
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user",
      transcript: "Hello",
    });
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "assistant",
      transcript: "Welcome",
    });
    const [user, assistant] = callbacks.onMessage.mock.calls.map(
      ([message]) => message as Message,
    );
    expect(assistant.timestamp).toBeLessThan(user.timestamp);
  });

  it("stops capture and playback immediately but drains the pending final transcript before resolving finish", async () => {
    const { channel, peer, audio } = await connect();
    channel.event({
      type: "input_audio_buffer.committed",
      item_id: "final-user",
      previous_item_id: null,
    });
    channel.event({ type: "response.created", response: { id: "r-final" } });
    channel.event({
      type: "output_audio_buffer.started",
      response_id: "r-final",
    });
    const done = vi.fn();
    const pending = client.finish();
    void pending.then(done);
    expect(client.finish()).toBe(pending);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(audio.muted).toBe(true);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(channel.sentTypes().slice(-2)).toEqual([
      "response.cancel",
      "output_audio_buffer.clear",
    ]);
    expect(channel.sentTypes()).not.toContain("input_audio_buffer.clear");
    expect(peer.close).not.toHaveBeenCalled();
    expect(client.sendText("after finish")).toBe(false);
    client.resume();
    client.setMuted(false);
    expect(stream.track.enabled).toBe(false);
    expect(audio.muted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(done).not.toHaveBeenCalled();
    channel.event({
      type: "response.output_audio_transcript.done",
      item_id: "unheard",
      transcript: "This must not enter the review.",
    });
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "final-user",
      transcript: "One more thing.",
    });
    expect(await pending).toEqual({ incompleteTranscription: false });
    expect(callbacks.onMessage).toHaveBeenCalledOnce();
    expect(callbacks.onMessage.mock.calls[0][0]).toMatchObject({
      id: "final-user",
      role: "user",
      text: "One more thing.",
    });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("ended");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits active final speech for transcription without requesting a new response", async () => {
    const { channel } = await connect();
    channel.event({
      type: "input_audio_buffer.speech_started",
      item_id: "vad-id",
    });
    channel.send.mockClear();
    const pending = client.finish();
    expect(channel.sentTypes()).toContain("input_audio_buffer.commit");
    expect(channel.sentTypes()).not.toContain("response.create");
    channel.event({
      type: "input_audio_buffer.committed",
      item_id: "manual-id",
      previous_item_id: null,
    });
    channel.event({
      type: "response.created",
      response: { id: "late-response" },
    });
    expect(channel.sentTypes()).not.toContain("response.create");
    expect(channel.sentTypes()).toContain("response.cancel");
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "manual-id",
      transcript: "Goodbye.",
    });
    await pending;
    expect(callbacks.onMessage.mock.calls[0][0]).toMatchObject({
      id: "manual-id",
      text: "Goodbye.",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("keeps a short drain window for speech and commits already travelling to the browser", async () => {
    const { channel } = await connect();
    const pending = client.finish();
    await vi.advanceTimersByTimeAsync(300);
    channel.event({
      type: "input_audio_buffer.speech_started",
      item_id: "in-flight",
    });
    expect(channel.sentTypes()).toContain("input_audio_buffer.commit");
    channel.event({
      type: "input_audio_buffer.committed",
      item_id: "in-flight",
      previous_item_id: null,
    });
    channel.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "in-flight",
      transcript: "Thank you.",
    });
    await pending;
    expect(callbacks.onMessage.mock.calls[0][0]).toMatchObject({
      text: "Thank you.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds transcript drain at 1800 ms, reports missing transcription and releases all resources", async () => {
    const { channel, peer } = await connect();
    channel.event({ type: "input_audio_buffer.committed", item_id: "missing" });
    const pending = client.finish();
    await vi.advanceTimersByTimeAsync(1_799);
    expect(peer.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ incompleteTranscription: true });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining("전사"),
    );
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles drain on transcription failure without manufacturing a user message", async () => {
    const { channel, peer } = await connect();
    channel.event({ type: "input_audio_buffer.committed", item_id: "failed" });
    const pending = client.finish();
    channel.event({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed",
    });
    expect(await pending).toEqual({ incompleteTranscription: true });
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "during"])(
    "does not stall a finish when the peer disconnects %s draining",
    async (when) => {
      const { peer, channel } = await connect();
      channel.event({
        type: "input_audio_buffer.committed",
        item_id: "unavailable",
      });
      if (when === "before") peer.state("disconnected");
      const pending = client.finish();
      if (when === "during") peer.state("disconnected");
      expect(await pending).toEqual({ incompleteTranscription: true });
      expect(peer.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("allows immediate unmount/close to abort drain and resolves its promise", async () => {
    const { channel } = await connect();
    channel.event({ type: "input_audio_buffer.committed", item_id: "late" });
    const oldHandler = channel.onmessage;
    const pending = client.finish();
    client.close();
    await pending;
    oldHandler?.({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "late",
        transcript: "too late",
      }),
    });
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
