// Cấu hình Playwright Test cho XRegion-EC2 chạy trên môi trường AWS thật.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /xregion-api-gateway\.spec\.js/,
  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),
  timeout: 600_000, // 10 phút mỗi bài test (để đủ thời gian chờ provisioning Step Functions & verification)
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1, // Tuân thủ Warm Pool <= 2 tài nguyên, chạy tuần tự từng test
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 }
      }
    }
  ]
});
