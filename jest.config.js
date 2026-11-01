/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // One suite at a time. The integration suites share one Redis instance and
  // each starts real BullMQ workers on the same queue names, so in parallel one
  // suite's worker consumes another suite's jobs (observed: "locked by another
  // worker" and versions stuck in `processing`). Serial runs are deterministic.
  maxWorkers: 1,
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts', '!src/worker.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: true, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true, noUnusedLocals: false } }] },
};
