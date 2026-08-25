import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Set before any module loads, so config/env.ts validates against these rather than
    // a developer's local .env — and so CI, which has no .env file, can boot at all.
    // The real database comes from mongodb-memory-server; this URI only satisfies validation.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/rntps-vitest-placeholder',
      JWT_SECRET: 'test-only-secret-that-is-long-enough-to-pass-validation',
      MAX_FAILED_LOGINS: '5',
      ACCOUNT_LOCK_MINUTES: '15',
    },
    globals: true,
    globalSetup: ['./src/test/globalSetup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15_000,
    /**
     * One retry.
     *
     * This is a MITIGATION, not a fix. Roughly one full run in five saw a single test
     * fail, and the culprit moved between files while every file passed 10+ consecutive
     * runs in isolation — which points at the in-memory mongod's connect/drop/disconnect
     * lifecycle across files rather than at the code under test. A retry keeps the suite
     * usable; if a test starts failing on the retry too, treat that as a real defect and
     * do not raise this number.
     */
    retry: 1,
    // globalSetup downloads the mongod binary on a cold machine, which needs headroom.
    hookTimeout: 120_000,
    // Spies are restored and their history cleared between tests. Without this,
    // vi.spyOn() on an already-spied method returns the existing spy, so call counts
    // leak across tests and "was not called" assertions fail for the wrong reason.
    clearMocks: true,
    restoreMocks: true,
    pool: 'forks',
    // Files run one at a time against the single shared mongod. Parallel files caused
    // intermittent timeouts and transient disconnects — an artefact of the in-memory
    // database under concurrent load, not of the code under test. A deterministic suite
    // is worth more than a few seconds, and CI runners have two cores anyway.
    fileParallelism: false,
  },
});
