import { defineConfig } from '@playwright/test';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:18080';

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
    trace: 'retain-on-failure',
  },
  webServer: process.env.QA_BASE_URL ? undefined : {
    command: `${python} server.py --reset`,
    url: `${baseURL}/health`,
    timeout: 15_000,
    reuseExistingServer: false,
  },
});
