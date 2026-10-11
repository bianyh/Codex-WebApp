import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: { headless: true, serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
});
