import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', UPLOAD_DIR: './uploads-test', PRIVATE_UPLOAD_DIR: './private-uploads-test', MAPS_MIN_INTERVAL_MS: '0' },
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false, // all test files share one database
    testTimeout: 30000,
  },
});
