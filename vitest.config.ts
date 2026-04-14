import { resolve } from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';

import electronViteConfig from './electron.vite.config';

export default mergeConfig(
  electronViteConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        // Tests run in plain Node — no Electron runtime. Reuse the server
        // mode shim so main-process modules that import from 'electron' can
        // be exercised under vitest (app.getPath etc resolve to real
        // homedir paths the same way server mode does).
        electron: resolve(__dirname, './src/server/electron-shim.ts'),
        'electron/main': resolve(__dirname, './src/server/electron-shim.ts'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      typecheck: {
        enabled: true,
        ignoreSourceErrors: true,
      },
      coverage: {
        provider: 'v8',
        all: false,
        reporter: ['html'],
      },
    },
  })
);
