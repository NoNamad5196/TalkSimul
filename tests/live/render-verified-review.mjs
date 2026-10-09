/** Offline UI render of a verified, synthetic-input review. No paid calls. */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = process.env.TALK_SIMUL_REVIEW_UI_URL ?? 'http://127.0.0.1:5188';
const url = new URL(baseURL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Only the localhost app may be rendered.');
const recordReportPath = resolve(process.env.TALK_SIMUL_REVIEW_SOURCE ?? 'tests/live/results/2026-10-09T06-15-55-942Z/report.json');
const meaningCheckPath = resolve(process.env.TALK_SIMUL_MEANING_CHECK ?? 'tests/live/results/review-meaning-check.json');
const sourceReport = JSON.parse(await readFile(recordReportPath, 'utf8'));
const meaningCheck = JSON.parse(await readFile(meaningCheckPath, 'utf8'));
const source = sourceReport.results.find(result => result.language === 'ja' && result.success)?.record;
if (!source || source.config.mode !== 'live' || source.config.language !== 'ja') throw new Error('Missing actual synthetic Japanese session record.');
const review = meaningCheck.correctedReview ?? meaningCheck.review;
if (!review || !Array.isArray(review.feedback) || !review.assessment || typeof review.summary !== 'string') throw new Error('The meaning-check JSON must provide correctedReview or review.');
if (![review.summary, ...Object.values(review.assessment), ...review.feedback.map(feedback => feedback.explanation)].every(text => typeof text === 'string' && /[\uac00-\ud7a3]/u.test(text))) throw new Error('Review explanations and assessments must include Korean text.');
for (const feedback of review.feedback) {
  if (!source.messages.some(message => message.role === 'user' && message.id === feedback.messageId && message.text === feedback.original)) throw new Error('Corrected review does not refer to the existing real transcript.');
}
const record = { ...source, review };
delete record.reviewError;
const output = resolve('tests/live/results', `review-ui-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const renders = [];
const check = (condition, message) => { if (!condition) throw new Error(message); };
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const denied = [];
    try {
      await context.route('**/*', async route => {
        const request = route.request();
        const requestURL = new URL(request.url());
        if (request.method() === 'POST' || (['http:', 'https:'].includes(requestURL.protocol) && !['127.0.0.1', 'localhost'].includes(requestURL.hostname))) {
          denied.push({ method: request.method(), path: requestURL.pathname });
          await route.abort();
        } else await route.continue();
      });
      await page.addInitScript(syntheticRecord => {
        localStorage.setItem('talksimul.sessions.v1', JSON.stringify([syntheticRecord]));
        if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => { throw new DOMException('Microphone disabled in offline review renderer.', 'NotAllowedError'); },
        });
      }, record);
      await page.goto(baseURL);
      await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '연습 기록', exact: true }).click();
      await page.locator('.record-open').click();
      await page.getByRole('heading', { name: '한마디 더, 한 걸음 더.' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dom = await page.evaluate(() => {
        const rect = element => {
          const r = element.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          summary: document.querySelector('.review-summary p')?.textContent?.trim(),
          tags: document.querySelector('.session-tags')?.textContent?.trim(),
          feedback: [...document.querySelectorAll('.feedback-card')].map(card => ({
            original: card.querySelector('.original-expression p')?.textContent?.trim(),
            improved: card.querySelector('.improved-expression p')?.textContent?.trim(),
            explanation: card.querySelector('.feedback-explanation p')?.textContent?.trim(),
            category: card.querySelector('.feedback-category')?.textContent?.trim(),
            markedChanges: [...card.querySelectorAll('mark')].map(mark => mark.textContent),
            card: rect(card),
            originalRect: rect(card.querySelector('.original-expression')),
            improvedRect: rect(card.querySelector('.improved-expression')),
          })),
          assessment: [...document.querySelectorAll('.assessment-grid > div')].map(element => element.textContent?.trim()),
          originalTranscript: [...document.querySelectorAll('.full-transcript > div > div')].map(element => ({
            role: element.querySelector('strong')?.textContent === '나' ? 'user' : 'assistant',
            text: element.querySelector('p')?.textContent?.trim(),
          })),
          visibleAlerts: [...document.querySelectorAll('[role="alert"]')].filter(element => element.getClientRects().length > 0).map(element => element.textContent?.trim()),
          bodyText: document.body.innerText,
        };
      });
      check(dom.documentWidth <= width + 1 && dom.bodyWidth <= width + 1, `Horizontal overflow at ${width}px.`);
      check(dom.summary === review.summary.trim(), 'The corrected summary was not rendered.');
      check(dom.feedback.length === review.feedback.length, 'The corrected feedback count was not rendered.');
      check(dom.originalTranscript.length === record.messages.length && dom.originalTranscript.every((message, index) => message.role === record.messages[index].role && message.text === record.messages[index].text.trim()), 'The original transcript was altered or omitted in the review DOM.');
      for (const [index, rendered] of dom.feedback.entries()) {
        const expected = review.feedback[index];
        check(rendered.original === expected.original && rendered.improved === expected.improved && rendered.explanation === expected.explanation, `DOM text differs from verified feedback ${index + 1}.`);
        check(rendered.card.left >= -1 && rendered.card.right <= width + 1, 'Feedback card exceeds the viewport width.');
        const a = rendered.originalRect, b = rendered.improvedRect;
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        check(overlapWidth <= 1 || overlapHeight <= 1, 'Original and improved text panels overlap.');
      }
      check(dom.visibleAlerts.length === 0, 'The offline corrected review displayed an error alert.');
      if (!review.insufficient && review.feedback.length === 0) check(dom.bodyText.includes('추가 교정 제안은 없어요'), 'A natural transcript was confused with missing evidence.');
      delete dom.bodyText;
      await page.screenshot({ path: resolve(output, `${width}-review.png`), fullPage: true, animations: 'disabled' });
      renders.push({ width, success: true, network: { denied, externalRequestsAllowed: false, postRequestsAllowed: false }, ...dom });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
await writeFile(resolve(output, 'layout.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), sourceRecord: recordReportPath, correctedReviewSource: meaningCheckPath,
  realConnectionRepeated: false, paidRequestsAllowed: false, temporaryBrowserProfilesOnly: true,
  semanticReview: 'DOM values are captured for human semantic inspection; layout checks do not prove meaning equivalence.',
  renders,
}, null, 2));
console.log(JSON.stringify({ success: true, widths: renders.map(render => render.width), feedbackCount: review.feedback.length, evidenceDirectory: output, paidRequests: 0 }));
