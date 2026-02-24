import type { PlaywrightTestConfig } from "@playwright/test";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const config: PlaywrightTestConfig = {
  testDir: "./tests/playwright",
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  webServer: {
    command: "OPENCLAW_TEST_MODE=1 NODE_ENV=test npm run dev",
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
};

export default config;

