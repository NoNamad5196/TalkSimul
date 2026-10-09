# Opt-in actual Realtime audit

These standalone `.mjs` files are excluded from the ordinary unit/E2E test discovery. Running them uses the configured provider and can incur API costs. Run only after explicit approval for this small synthetic-input test.

Prerequisites:

- The actual local TalkSimul frontend and configured API server are running.
- Four non-sensitive synthetic WAV fixtures exist: `en-1.wav`, `en-2.wav`, `ja-1.wav`, `ja-2.wav` in `tests/live/fixtures` (or the explicit fixture directory).
- Each fixture is at most 12 seconds. Both languages' fixtures should concern café ordering. English uses beginner difficulty; Japanese uses challenge difficulty.
- Installed Microsoft Edge is used with a new, temporary Playwright profile. No browser download, real microphone, user profile, or OS settings are used.

PowerShell invocation:

```powershell
$env:TALK_SIMUL_RUN_LIVE = '1'
$env:TALK_SIMUL_LIVE_URL = 'http://127.0.0.1:5188'
$env:TALK_SIMUL_LIVE_FIXTURES = 'C:\Users\nonam\Documents\TalkSimul\tests\live\fixtures'
node tests/live/realtime-smoke.mjs
```

Optionally set `TALK_SIMUL_LIVE_LANGUAGE` to `en` or `ja`; the default is `both`. Each language runs once with a 60-second hard limit on the local WebRTC session. The app is limited to one request per session for Realtime connection, hint, hint speech, and review. No OpenAI credentials or `.env` are read by this harness. Review completion is checked after the voice connection is closed.

The harness drives the actual app UI and localhost APIs. It replaces `getUserMedia` with a WebAudio stream fed exclusively by synthetic WAV data, observes actual Realtime events and inbound audio RTP statistics, and checks hint pause/return, two voice transcripts, actual grounded feedback, and app cleanup. Empty corrections are valid for already-natural user speech; any supplied correction must match a real transcript ID and text. Hint playback accepts either local SpeechSynthesis start/end events or fallback HTMLAudio progress/end events. Those events do not establish that a person heard the speakers. The final AI reply may still be playing when the test chooses to finish, exercising response cancellation within the session time limit.

JSON evidence and screenshots are written beneath `tests/live/results/<timestamp>`. They contain only synthetic-test conversation data and allowlisted connection metadata; no SDP, session secrets, authorization headers, or raw microphone recording.

## Protected Vercel production audit

Only the exact deployed origin `https://moru-talksimul.vercel.app` is supported.
The existing Vercel CLI login loads an already-created project automation token
into memory. The test verifies the linked project and `all` authentication policy,
and adds the token only to requests to that exact origin. It does not create a
token, change protection, access the user browser profile, or persist credentials.

```powershell
$env:TALK_SIMUL_RUN_LIVE = '1'
$env:TALK_SIMUL_RUN_VERCEL = '1'
$env:TALK_SIMUL_LIVE_URL = 'https://moru-talksimul.vercel.app'
node tests/live/realtime-smoke.mjs
```

Production sessions have a 90-second hard bound to allow network and cold-start
latency. The same per-endpoint call limits and synthetic-only microphone apply.
The audit additionally checks Korean review explanations, 390px review layout,
and transcript/review persistence after reload without a new microphone request.
Physical microphone quality, human speaker listening, real mobile devices, and
other browser engines require separate checks.
