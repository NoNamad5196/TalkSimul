import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// Use an installed browser in an isolated temporary profile; never the user's profile.
const edgeInstalled = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].some((path) => existsSync(path));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.TALK_SIMUL_E2E_URL ?? "http://127.0.0.1:5188",
    browserName: "chromium",
    ...(edgeInstalled ? { channel: "msedge" } : {}),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
