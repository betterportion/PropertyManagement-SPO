import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests that drive the real app in a browser.
 *
 * Login is Google OIDC, which cannot run headlessly, so global-setup mints a
 * signed session cookie straight into the sessions table -- the same technique
 * used for manual local testing -- and saves it as Playwright storage state.
 * The application gains no test-only login path.
 *
 * Requirements to run:
 *   - a Postgres reachable at TEST_DATABASE_URL, migrated and seeded
 *   - the dev server (started here as webServer, or reused if already up)
 * SESSION_SECRET must match between the server and global-setup, which is why
 * both default to the same value below.
 */

const PORT = process.env.E2E_PORT ?? "5050";
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET ?? "local-test-secret";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:verify@localhost:55432/postgres";

export default defineConfig({
  testDir: "./e2e",
  // e2e specs mutate a shared database, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    storageState: "e2e/.auth/admin.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    // Desktop runs every spec except the mobile-only one.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    // A phone-sized viewport runs only the mobile spec, where the layout and
    // the collapsed sidebar behave differently.
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],

  webServer: {
    command: `npm run dev`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT,
      DATABASE_URL,
      SESSION_SECRET,
      // Discovery works with these placeholders; login does not, which the
      // cookie-based auth makes unnecessary.
      OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? "https://accounts.google.com",
      OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID ?? "e2e-placeholder",
      OIDC_SCOPES: "openid email profile",
    },
  },
});
