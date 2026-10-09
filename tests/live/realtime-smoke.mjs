/**
 * Explicitly opt-in paid integration audit. Not discovered by Vitest or normal
 * Playwright E2E. Run only after the user authorizes the configured provider.
 * Never reads the OpenAI key or .env. Protected deployment authorization stays
 * in memory and is sent only to the exact approved app origin.
 */
import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { installSyntheticCapture } from './browser-harness.mjs';
import { loadVercelAuditAuth } from './vercel-audit-auth.mjs';

if (process.env.TALK_SIMUL_RUN_LIVE !== '1') {
  console.error('Not run: set TALK_SIMUL_RUN_LIVE=1 only after paid synthetic-input verification is authorized.');
  process.exit(2);
}

const baseURL = process.env.TALK_SIMUL_LIVE_URL ?? 'http://127.0.0.1:5188';
const parsedURL = new URL(baseURL);
const isLocal = ['127.0.0.1', 'localhost'].includes(parsedURL.hostname) && parsedURL.protocol === 'http:';
const isProduction = baseURL === 'https://moru-talksimul.vercel.app' && process.env.TALK_SIMUL_RUN_VERCEL === '1';
if (!isLocal && !isProduction) throw new Error('Explicitly authorized localhost or production audit required.');
const authorization = isProduction ? await loadVercelAuditAuth(parsedURL.origin) : null;
const maxSessionMs = isProduction ? 90_000 : 60_000;
const fixtureDirectory = resolve(process.env.TALK_SIMUL_LIVE_FIXTURES ?? 'tests/live/fixtures');
const selected = process.env.TALK_SIMUL_LIVE_LANGUAGE ?? 'both';
if (!['en', 'ja', 'both'].includes(selected)) throw new Error('TALK_SIMUL_LIVE_LANGUAGE must be en, ja, or both.');
const cases = [
  { language: 'en', scenario: 'cafe', level: 'beginner', scenarioLabel: '카페에서 주문하기', levelLabel: '입문', scenarioPattern: /cafe|café|coffee|drink|latte|order/i },
  { language: 'ja', scenario: 'cafe', level: 'challenge', scenarioLabel: '카페에서 주문하기', levelLabel: '도전', scenarioPattern: /コーヒー|ラテ|カフェ|飲み物|注文|ホット|アイス|サイズ/ },
].filter(item => selected === 'both' || item.language === selected);
for (const item of cases) {
  item.fixtures = await Promise.all([1, 2].map(async index => {
    const path = resolve(fixtureDirectory, `${item.language}-${index}.wav`);
    const data = await readFile(path);
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${basename(path)} must be a WAV fixture.`);
    return { name: basename(path), base64: data.toString('base64') };
  }));
}

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outputDirectory = resolve('tests/live/results', runId);
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
});
const results = [];
const check = (value, message) => { if (!value) throw new Error(message); };

try {
  for (const item of cases) {
    const result = { language: item.language, configuration: { language: item.language, scenario: item.scenario, level: item.level, mode: 'live' }, fixtures: item.fixtures.map(fixture => fixture.name), checks: {}, api: [], fixturePlayback: [] };
    const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const postCounts = new Map();
    let sessionStarted = null;
    const remaining = (desired = 12_000) => sessionStarted === null ? desired : Math.max(1, Math.min(desired, maxSessionMs - 4_000 - (Date.now() - sessionStarted)));
    const snapshot = () => page.evaluate(() => window.__talkSimulLiveAudit.snapshot());
    const waitForIdle = async () => {
      await page.waitForFunction(() => document.querySelector('.state-label')?.textContent === '편하게 이야기해 주세요', null, { timeout: remaining(15_000) });
    };
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== parsedURL.origin) {
        await route.abort();
        return;
      }
      if (request.method() === 'POST' && url.pathname.startsWith('/api/')) {
        const count = (postCounts.get(url.pathname) ?? 0) + 1;
        postCounts.set(url.pathname, count);
        if (!['/api/realtime', '/api/hint', '/api/review', '/api/speech'].includes(url.pathname) || count > 1) {
          result.api.push({ path: url.pathname, blocked: true, reason: 'opt-in audit call limit' });
          await route.abort();
          return;
        }
        if (url.pathname === '/api/realtime') {
          const config = request.postDataJSON()?.config;
          result.requestedConfiguration = config;
        }
      }
      await route.continue(authorization && url.origin === parsedURL.origin ? {
        headers: { ...request.headers(), 'x-vercel-protection-bypass': authorization.bypass },
      } : undefined);
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) result.api.push({ path: url.pathname, status: response.status() });
    });
    await page.addInitScript(installSyntheticCapture, { maxSessionMs });

    try {
      await page.goto(baseURL);
      await page.getByRole('heading', { name: '어서 와요, 오늘도 한마디!' }).waitFor();
      if (item.language === 'ja') await page.getByRole('button', { name: /일본어.*日本語/ }).click();
      await page.getByRole('button', { name: new RegExp(item.scenarioLabel) }).first().click();
      await page.getByRole('button', { name: new RegExp(`^${item.levelLabel} `) }).click();
      await page.getByRole('button', { name: /실시간 AI 음성 대화/ }).click();
      await page.getByRole('checkbox', { name: '음성·대화 전송과 API 비용을 확인했어요.' }).check();
      check((await snapshot()).captureRequests === 0, 'Microphone requested before explicit start.');
      sessionStarted = Date.now();
      await page.getByRole('button', { name: '마이크 켜고 대화 시작', exact: true }).click();
      await page.waitForFunction(() => window.__talkSimulLiveAudit.snapshot().peerStates.includes('connected'), null, { timeout: remaining(20_000) });
      await page.locator('.message-assistant').first().waitFor({ timeout: remaining(15_000) });
      await waitForIdle();
      result.checks.actualWebRTCConnected = true;
      check(Object.entries(result.configuration).every(([key, value]) => result.requestedConfiguration?.[key] === value), 'Selected configuration was not sent to the real API.');
      result.checks.configurationApplied = true;

      result.fixturePlayback.push(await page.evaluate(base64 => window.__talkSimulLiveAudit.playFixture(base64), item.fixtures[0].base64));
      await page.waitForFunction(() => document.querySelectorAll('.message-user').length >= 1, null, { timeout: remaining(15_000) });
      await page.waitForFunction(() => document.querySelectorAll('.message-assistant').length >= 2, null, { timeout: remaining(15_000) });
      // The completed first transcript is available; opening the actual hint
      // control now also exercises interruption of any remaining AI playback.
      result.checks.firstVoiceTurn = true;

      await page.getByRole('button', { name: '뭐라고 말하지?', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('.hint-card p').waitFor({ timeout: remaining(12_000) });
      result.hint = { text: await dialog.locator('.hint-card p').innerText(), meaning: await dialog.locator('.hint-card > span').innerText() };
      let paused = await snapshot();
      check(paused.localTracks.filter(track => track.readyState === 'live').every(track => !track.enabled), 'Hint did not suspend the synthetic microphone.');
      check(paused.audio.filter(audio => audio.stream).every(audio => audio.muted), 'Hint did not mute AI output.');
      result.checks.hintPausedBothDirections = true;

      await dialog.getByRole('button', { name: '발음 듣기', exact: true }).click();
      await page.waitForFunction(() => {
        const audit = window.__talkSimulLiveAudit.snapshot();
        return audit.audio.some(audio => !audio.stream && audio.maxCurrentTime > 0 && audio.events.some(event => event.type === 'ended')) || audit.nativeSpeech.some(speech => speech.localService && speech.events.some(event => event.type === 'start') && speech.events.some(event => event.type === 'end'));
      }, null, { timeout: remaining(16_000) });
      result.checks.hintAudioPlaybackEvents = true;
      const hintAudio = await snapshot();
      result.hintPlaybackMethod = hintAudio.nativeSpeech.some(speech => speech.events.some(event => event.type === 'end')) ? 'local device speech' : 'server MP3';
      if (postCounts.has('/api/speech')) {
        check(result.api.some(call => call.path === '/api/speech' && call.status === 200), 'The fallback speech request did not succeed.');
        result.checks.hintSpeechApi200 = true;
      }
      await page.getByRole('button', { name: '이제 말해 볼게요', exact: true }).click();
      check(await page.locator('.message-user').count() === 1, 'A displayed hint was recorded as a user utterance.');
      const resumed = await snapshot();
      check(resumed.localTracks.filter(track => track.readyState === 'live').every(track => track.enabled), 'Hint return did not restore the microphone.');
      result.checks.hintReturnedWithoutFakeUtterance = true;

      result.fixturePlayback.push(await page.evaluate(base64 => window.__talkSimulLiveAudit.playFixture(base64), item.fixtures[1].base64));
      await page.waitForFunction(() => document.querySelectorAll('.message-user').length >= 2, null, { timeout: remaining(15_000) });
      await page.waitForFunction(() => document.querySelectorAll('.message-assistant').length >= 3, null, { timeout: remaining(15_000) });
      // End after the final actual transcript/audio arrives. Long challenge
      // replies need not finish playback before a user chooses to end a session.
      result.checks.secondVoiceTurnAfterHint = true;
      result.inboundAudio = await page.evaluate(() => window.__talkSimulLiveAudit.inboundAudioStats());
      check(result.inboundAudio.some(stat => stat.bytesReceived > 0 && stat.packetsReceived > 0), 'No inbound WebRTC audio packets.');
      result.checks.actualAIAudioPackets = true;
      await page.screenshot({ path: resolve(outputDirectory, `${item.language}-conversation.png`), fullPage: true });
      await page.locator('.finish-button').click();
      await page.getByRole('dialog').getByRole('button', { name: '마치고 복기하기', exact: true }).click();
      await page.getByRole('heading', { name: '한마디 더, 한 걸음 더.' }).waitFor({ timeout: 5_000 });
      result.sessionElapsedMs = Date.now() - sessionStarted;
      result.afterFinish = await snapshot();
      check(result.sessionElapsedMs <= maxSessionMs && !result.afterFinish.hardStopped, 'Session exceeded its bounded audit duration.');
      check(result.afterFinish.peerStates.every(state => state === 'closed'), 'App left a peer connection open after finish.');
      check(result.afterFinish.localTracks.every(track => track.readyState === 'ended'), 'App left a synthetic input track live after finish.');
      check(result.afterFinish.remoteTracks.every(track => track.readyState === 'ended'), 'App left a remote audio track live after finish.');
      result.checks.appTransportCleanup = true;

      await page.waitForFunction(() => {
        const record = JSON.parse(localStorage.getItem('talksimul.sessions.v1') ?? '[]')[0];
        return record?.review || record?.reviewError;
      }, null, { timeout: 45_000 });
      result.record = await page.evaluate(() => JSON.parse(localStorage.getItem('talksimul.sessions.v1') ?? '[]')[0]);
      check(result.record?.review && !result.record.reviewError, 'The real review request did not complete.');
      check(!result.record.review.insufficient, 'Two actual voice turns still produced an insufficient review.');
      const userMessages = result.record.messages.filter(message => message.role === 'user');
      check(userMessages.length >= 2 && userMessages.every(message => message.source === 'voice'), 'Review is not grounded in two voice transcript messages.');
      check(result.record.review.feedback.every(feedback => userMessages.some(message => message.id === feedback.messageId && message.text === feedback.original)), 'Review feedback is not grounded in actual user transcript IDs/text.');
      check(['delivery', 'naturalness', 'grammar', 'vocabulary'].every(key => typeof result.record.review.assessment?.[key] === 'string' && result.record.review.assessment[key].trim().length > 0), 'Review assessment fields are missing.');
      check(result.record.messages.filter(message => message.role === 'assistant').some(message => item.scenarioPattern.test(message.text)), 'AI text did not reflect the chosen practice scenario.');
      check(item.language === 'en' ? userMessages.every(message => /[a-z]/i.test(message.text)) : userMessages.every(message => /[\u3040-\u30ff\u4e00-\u9fff]/.test(message.text)), 'User ASR did not reflect the selected language.');
      result.checks.groundedActualReview = true;
      result.checks.scenarioAndLanguageInActualConversation = true;
      check(/[가-힣]/.test(result.record.review.summary) && Object.values(result.record.review.assessment).every(value => /[가-힣]/.test(value)), 'Review explanations are not Korean.');
      result.checks.koreanReviewExplanations = true;
      await page.screenshot({ path: resolve(outputDirectory, `${item.language}-review.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile review has horizontal overflow.');
      await page.screenshot({ path: resolve(outputDirectory, `${item.language}-review-mobile.png`), fullPage: true });
      result.checks.mobileReviewLayout = true;
      const savedId = result.record.id;
      await page.reload();
      await page.getByRole('heading', { name: '어서 와요, 오늘도 한마디!' }).waitFor();
      const restored = await page.evaluate(id => JSON.parse(localStorage.getItem('talksimul.sessions.v1') ?? '[]').find(record => record.id === id), savedId);
      check(restored?.review && restored.messages.length === result.record.messages.length, 'Saved transcript or review was lost after reload.');
      check((await snapshot()).captureRequests === 0, 'Reload unexpectedly requested microphone access.');
      result.checks.historySurvivesReload = true;
      result.success = true;
    } catch (error) {
      result.success = false;
      result.failure = error instanceof Error ? error.message.split('\n')[0] : 'Unspecified live audit failure.';
      if (!page.isClosed()) {
        try { result.failureSnapshot = await snapshot(); } catch { /* Browser already gone. */ }
        try { await page.screenshot({ path: resolve(outputDirectory, `${item.language}-failure.png`), fullPage: true }); } catch { /* Best effort. */ }
      }
    } finally {
      if (!page.isClosed()) {
        await page.evaluate(async () => {
          window.dispatchEvent(new Event('pagehide'));
          await window.__talkSimulLiveAudit?.cleanup();
        }).catch(() => {});
        result.finalCleanup = await snapshot().catch(() => null);
      }
      await context.close();
      results.push(result);
      await writeFile(resolve(outputDirectory, 'report.json'), JSON.stringify({
        generatedAt: new Date().toISOString(), browser: `Microsoft Edge ${browser.version()}`,
        mode: 'actual provider with synthetic user WAV input', target: baseURL, maxSessionSeconds: maxSessionMs / 1000,
        audibleListeningVerified: false, exactCostVerified: false,
        noRealMicrophone: true, credentialsRecorded: false, results,
      }, null, 2));
      console.log(JSON.stringify({ language: result.language, success: result.success, checks: result.checks, failure: result.failure ?? null, sessionElapsedMs: result.sessionElapsedMs ?? null }));
    }
  }
} finally { await browser.close(); }
console.log(`Live audit evidence: ${outputDirectory}`);
if (results.some(result => !result.success)) process.exitCode = 1;
