import { resolve } from 'path';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vite config for building the server (Node.js target).
 * Aliases 'electron' and 'electron-store' to shims so manager imports work.
 * Outputs ESM to avoid interop issues with ESM-only deps (ansi-regex, nanoid, etc.).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  build: {
    target: 'node22',
    outDir: 'out/server',
    ssr: true,
    lib: {
      entry: resolve('src/server/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        'node-pty',
        'ws',
        'fastify',
        '@fastify/static',
        '@fastify/websocket',
        'shell-env',
        // Node built-ins
        'fs',
        'fs/promises',
        'path',
        'os',
        'child_process',
        'util',
        'url',
        'node:child_process',
        'node:fs/promises',
        'node:path',
        'node:util',
        'dotenv/config',
      ],
      output: {
        entryFileNames: '[name].mjs',
        // Inject __dirname/__filename shim for ESM — needed by bundled code from src/main/util.ts
        banner: `import { fileURLToPath as __fileURLToPath } from 'url';\nimport { dirname as __pathDirname } from 'path';\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
      },
    },
  },
  resolve: {
    alias: {
      // Shim Electron APIs for server build
      electron: resolve('src/server/electron-shim.ts'),
      'electron/main': resolve('src/server/electron-shim.ts'),
      'electron-store': resolve('src/server/electron-store-shim.ts'),
      'electron-context-menu': resolve('src/server/electron-store-shim.ts'),
      'electron-updater': resolve('src/server/electron-store-shim.ts'),
      '@electron-toolkit/typed-ipc/main': resolve('src/server/electron-store-shim.ts'),
    },
  },
});
