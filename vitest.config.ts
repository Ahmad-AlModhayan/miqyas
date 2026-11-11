// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // End-to-end tests launch Chromium several times per test.
    testTimeout: 60_000,
  },
});
