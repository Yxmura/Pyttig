import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 300000,
  retries: 0,
  // Serial: each test boots Pyodide + WASM workers (heavy on RAM/CPU).
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8765",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "python pyttig.py --port 8765 --no-browser",
      url: "http://127.0.0.1:8765/__pyttig__/ping",
      timeout: 30000,
      reuseExistingServer: true,
    },
    {
      // Static hosting simulation: dist + isolation headers + /api/proxy.
      command: "node scripts/vercel-sim.mjs",
      url: "http://127.0.0.1:8902/",
      timeout: 30000,
      reuseExistingServer: true,
    },
  ],
});
