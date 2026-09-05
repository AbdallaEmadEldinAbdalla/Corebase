import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One node, one control database, one set of host ports — the same constraint
    // the worker's suites have. Here it matters more: the fixtures are two
    // *provisioned projects*, and a second file racing them would fight over the
    // node's capacity and ports rather than merely over rows.
    fileParallelism: false,
    // Provisioning two full projects — six containers, two poolers, two data APIs
    // — before a single assertion runs. The default 5s timeout is not in the same
    // order of magnitude.
    testTimeout: 180_000,
    hookTimeout: 900_000,
  },
});
