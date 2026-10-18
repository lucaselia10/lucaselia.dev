import { defineConfig, devices } from "@playwright/test";

// Not 4321: that is the Astro dev-server default, so a running `pnpm dev:web` would collide.
const DEV_PORT = 4329;
const SITE_PORT = 4331;

function serverEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

// Astro 7 detaches `astro preview` into a background daemon when it detects a coding agent,
// which Playwright reports as an early exit and which leaves the port held. --ignore-lock
// keeps the server in the foreground; Playwright already checks the port.
// The two servers build into separate directories and start one after the other.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  projects: [
    {
      // Development profile with an ask URL, so the assistant UI and the fixture are present.
      name: "development",
      testMatch: "homepage.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${DEV_PORT}` },
    },
    {
      // The production site exactly as `pnpm build:site` builds it.
      name: "production",
      testMatch: "site.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${SITE_PORT}` },
    },
  ],
  webServer: [
    {
      command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${DEV_PORT} --ignore-lock`,
      url: `http://127.0.0.1:${DEV_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      // Never reachable: the assistant renders, and any question fails as unavailable.
      env: serverEnv({
        ASTRO_OUT_DIR: "dist-e2e",
        PUBLIC_ASK_API_URL: "http://127.0.0.1:9/ask",
        PUBLIC_ASK_STREAMING: "",
        PORTFOLIO_SITE: "",
      }),
    },
    {
      command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${SITE_PORT} --ignore-lock`,
      url: `http://127.0.0.1:${SITE_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: serverEnv({
        ASTRO_OUT_DIR: "dist-e2e-site",
        PUBLIC_ASK_API_URL: "",
        PUBLIC_ASK_STREAMING: "",
        PORTFOLIO_SITE: "production",
      }),
    },
  ],
});
