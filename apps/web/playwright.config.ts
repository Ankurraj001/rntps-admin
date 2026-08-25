import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real stack: the Vite dev server proxying to the API,
 * which talks to whatever MONGODB_URI is configured. They are deliberately kept to the
 * critical paths — sign-in, the guard boundaries, and the money flow — since the API's
 * own suite already covers behaviour in depth.
 *
 * Point E2E_BASE_URL at a deployed preview to run these against Netlify instead.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Shared database; parallel runs would fight over state.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
