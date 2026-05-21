import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { builtinModules } from 'module';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// What stays external in the otherwise self-contained server bundle:
//  - node-pty: native module, can't be bundled.
//  - ws + @fastify/websocket: bundling `ws` mangles its buffer-util mask/unmask
//    fallback (`bufferUtil.unmask is not a function`) and crashes on the first
//    masked client frame; @fastify/websocket must be external too, or its
//    bundled `require('ws')` hits a broken ESM/CJS interop (`WebSocket.Server is
//    not a constructor`). bufferutil/utf-8-validate are ws's optional native
//    helpers (ws falls back to JS if absent).
//  - Node built-ins (bare + `node:`-prefixed), incl. ones reached transitively.
// Everything else is bundled (ssr.noExternal) so `npm prune --omit=dev` can't
// drop a runtime-reached dep (e.g. ansi-colors). All externals here are real
// `dependencies`, so they survive the prune and resolve from node_modules.
const nodeBuiltins = new Set(builtinModules);
const externalDeps = new Set(['node-pty', 'ws', '@fastify/websocket', 'bufferutil', 'utf-8-validate']);
function isExternal(id: string): boolean {
  return externalDeps.has(id) || id.startsWith('node:') || nodeBuiltins.has(id);
}

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
  // Bundle all JS deps into a self-contained server bundle; only the externals
  // above (native + the ws stack) stay as runtime requires from node_modules.
  ssr: {
    noExternal: true,
  },
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
      external: isExternal,
      output: {
        entryFileNames: '[name].mjs',
        // ESM shims for bundled CJS code: `require` (fastify's plugin-name
        // resolver calls it at runtime; also resolves the external ws stack) and
        // __dirname/__filename (used by bundled code from src/main/util.ts).
        banner: `import { createRequire as __createRequire } from 'module';\nimport { fileURLToPath as __fileURLToPath } from 'url';\nimport { dirname as __pathDirname } from 'path';\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
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
