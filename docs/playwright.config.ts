import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const externalBaseURL = process.env.DOCS_BASE_URL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 90_000,
  expect: { timeout: 60_000 },
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: '../test-results/docs',
  use: {
    baseURL: externalBaseURL || 'http://127.0.0.1:3001',
    reducedMotion: 'reduce',
    navigationTimeout: 90_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
  },
  projects: [{ name: 'docs-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: externalBaseURL ? undefined : {
    command: 'npm run docs:dev',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
