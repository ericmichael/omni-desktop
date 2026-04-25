import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vite plugin that (re)starts a node process after each watch rebuild.
 * Only active when Vite is running in watch mode (--watch flag).
 */
function serverRestart(entry: string): Plugin {
  let proc: ChildProcess | null = null;

  const kill = () => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  };

  return {
    name: 'server-restart',
    apply: 'build',
    closeBundle() {
      // closeBundle fires in both one-shot and watch builds.
      // In one-shot mode we don't want to spawn — the npm script handles it.
      // Vite sets this.meta.watchMode in watch mode.
      if (!(this as unknown as { meta: { watchMode: boolean } }).meta.watchMode) {
        return;
      }
      kill();
      proc = spawn('node', [entry], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development' },
      });
      proc.on('exit', () => {
        proc = null;
      });
    },
  };
}

/**
 * Vite config for building the server (Node.js target).
 * Aliases 'electron' and 'electron-store' to shims so manager imports work.
 * Outputs ESM to avoid interop issues with ESM-only deps (ansi-regex, nanoid, etc.).
 */
const platformDefines = {
  __PLATFORM_URL__: JSON.stringify(process.env.OMNI_PLATFORM_URL || ''),
};

export default defineConfig({
  define: platformDefines,
  plugins: [tsconfigPaths(), serverRestart('out/server/index.mjs')],
  build: {
    target: 'node22',
    outDir: 'out/server',
    emptyOutDir: false,
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
        'node:crypto',
        'node:fs',
        'node:fs/promises',
        'node:http',
        'node:net',
        'node:os',
        'node:path',
        'node:sqlite',
        'node:url',
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
