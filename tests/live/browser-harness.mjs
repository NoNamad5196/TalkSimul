/** Browser-only instrumentation. Never delegates to the real getUserMedia. */
export function installSyntheticCapture(options = {}) {
  const maxSessionMs = options.maxSessionMs === 90_000 ? 90_000 : 60_000;
  const peers = [];
  const captures = [];
  const remoteTracks = [];
  const audioElements = [];
  const nativeSpeech = [];
  const events = [];
  let hardTimer;
  let captureRequests = 0;
  let hardStopped = false;
  let sessionStartedAt = null;
  const now = () => Math.round(performance.now());

  function disarm() {
    clearTimeout(hardTimer);
    hardTimer = undefined;
  }

  async function cleanup() {
    disarm();
    for (const peer of peers) {
      if (peer.connectionState !== 'closed') peer.close();
    }
    remoteTracks.forEach(track => track.stop());
    for (const capture of captures) {
      for (const source of capture.sources) {
        try { source.stop(); } catch { /* Already ended. */ }
        source.disconnect();
      }
      capture.stream.getTracks().forEach(track => track.stop());
      if (capture.context.state !== 'closed') await capture.context.close();
    }
    for (const { element } of audioElements) {
      element.pause();
      element.srcObject = null;
      element.removeAttribute('src');
      element.load();
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      peers.push(this);
      if (sessionStartedAt === null) sessionStartedAt = now();
      if (!hardTimer) hardTimer = setTimeout(() => {
        hardStopped = true;
        void cleanup();
      }, maxSessionMs);
      this.addEventListener('track', event => remoteTracks.push(event.track));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      channel.addEventListener('message', event => {
        try {
          const value = JSON.parse(event.data);
          // No session config, SDP, raw provider error, headers, or credentials.
          const entry = { type: value.type, at: now() };
          if (value.item_id) entry.itemId = value.item_id;
          if (value.response_id ?? value.response?.id) entry.responseId = value.response_id ?? value.response.id;
          if (value.type === 'conversation.item.input_audio_transcription.completed' || value.type === 'response.output_audio_transcript.done') entry.text = value.transcript;
          if (value.type === 'response.output_text.done') entry.text = value.text;
          if (value.type === 'response.done') entry.status = value.response?.status;
          if (value.type === 'error') entry.code = value.error?.code ?? 'unspecified';
          if (!value.type?.endsWith('.delta')) events.push(entry);
        } catch { /* Non-JSON data is not audit evidence. */ }
      });
      return channel;
    }
    close() {
      super.close();
      if (peers.every(peer => peer.connectionState === 'closed')) disarm();
    }
  };

  const NativeAudio = window.Audio;
  function ObservedAudio(...args) {
    const element = new NativeAudio(...args);
    const entry = { element, maxCurrentTime: 0, events: [] };
    audioElements.push(entry);
    for (const type of ['playing', 'timeupdate', 'ended', 'error', 'pause']) {
      element.addEventListener(type, () => {
        entry.maxCurrentTime = Math.max(entry.maxCurrentTime, element.currentTime);
        if (type !== 'timeupdate') entry.events.push({ type, at: now(), currentTime: element.currentTime });
      });
    }
    return element;
  }
  ObservedAudio.prototype = NativeAudio.prototype;
  window.Audio = ObservedAudio;

  if ('speechSynthesis' in window) {
    const nativeSpeak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = utterance => {
      const entry = { localService: utterance.voice?.localService ?? null, lang: utterance.lang, events: [] };
      nativeSpeech.push(entry);
      for (const type of ['start', 'end', 'error']) utterance.addEventListener(type, event => {
        entry.events.push({ type, at: now(), ...(type === 'error' ? { error: event.error } : {}) });
      });
      return nativeSpeak(utterance);
    };
  }

  // The original function is deliberately not retained or invoked.
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async constraints => {
      if (constraints?.video) throw new DOMException('Video is not permitted by this synthetic harness.', 'NotAllowedError');
      captureRequests++;
      const context = new AudioContext({ sampleRate: 48_000 });
      const destination = context.createMediaStreamDestination();
      const silence = context.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
      const capture = { context, destination, stream: destination.stream, sources: [silence] };
      captures.push(capture);
      return destination.stream;
    },
  });

  window.__talkSimulLiveAudit = {
    async playFixture(base64) {
      const capture = [...captures].reverse().find(item => item.stream.getAudioTracks().some(track => track.readyState === 'live'));
      if (!capture) throw new Error('No active synthetic capture stream.');
      if (!capture.stream.getAudioTracks().every(track => track.enabled)) throw new Error('Synthetic microphone is muted.');
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const buffer = await capture.context.decodeAudioData(bytes.buffer);
      if (buffer.duration > 12) throw new Error('Fixture exceeds the 12 second safety limit.');
      await capture.context.resume();
      const source = capture.context.createBufferSource();
      source.buffer = buffer;
      source.connect(capture.destination);
      capture.sources.push(source);
      const started = now();
      await new Promise(resolve => {
        source.addEventListener('ended', resolve, { once: true });
        source.start(capture.context.currentTime + 0.15);
      });
      source.disconnect();
      return { duration: buffer.duration, started, ended: now(), source: 'synthetic WAV only' };
    },
    snapshot() {
      return {
        captureRequests,
        realMicrophoneRequests: 0,
        hardStopped,
        sessionStartedAt,
        elapsedMs: sessionStartedAt === null ? 0 : now() - sessionStartedAt,
        peerStates: peers.map(peer => peer.connectionState),
        localTracks: captures.flatMap(capture => capture.stream.getTracks().map(track => ({ readyState: track.readyState, enabled: track.enabled }))),
        remoteTracks: remoteTracks.map(track => ({ readyState: track.readyState, kind: track.kind })),
        audio: audioElements.map(({ element, maxCurrentTime, events: audioEvents }) => ({
          stream: Boolean(element.srcObject), paused: element.paused, muted: element.muted,
          currentTime: element.currentTime, maxCurrentTime, events: audioEvents,
        })),
        audioContextStates: captures.map(capture => capture.context.state),
        nativeSpeech,
        nativeSpeechState: 'speechSynthesis' in window ? { speaking: speechSynthesis.speaking, pending: speechSynthesis.pending } : null,
        events,
      };
    },
    async inboundAudioStats() {
      const received = [];
      for (const peer of peers) {
        if (peer.connectionState === 'closed') continue;
        const stats = await peer.getStats();
        for (const stat of stats.values()) {
          if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio')) {
            received.push({ bytesReceived: stat.bytesReceived, packetsReceived: stat.packetsReceived,
              totalAudioEnergy: stat.totalAudioEnergy, totalSamplesReceived: stat.totalSamplesReceived,
              totalSamplesDuration: stat.totalSamplesDuration });
          }
        }
      }
      return received;
    },
    cleanup,
  };
}
