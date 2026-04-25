import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import { createHtmlPlugin } from 'vite-plugin-html';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vite config for building the browser renderer (no Electron dependencies).
 * Produces a standalone SPA that uses WebSocket transport.
 */
const SERVER_PORT = parseInt(process.env['PORT'] ?? '3001', 10);

export default defineConfig(({ mode }) => {
  const platformDefines = {
    __PLATFORM_URL__: JSON.stringify(process.env.OMNI_PLATFORM_URL || ''),
  };

  const cspScriptSrc = mode === 'development' ? "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'" : "'self'";

  return {
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: `http://localhost:${SERVER_PORT}`,
        },
        '/ws': {
          target: `http://localhost:${SERVER_PORT}`,
          ws: true,
        },
        '/proxy': {
          target: `http://localhost:${SERVER_PORT}`,
          ws: true,
        },
      },
    },
    define: platformDefines,
    plugins: [
      tailwindcss(),
      react(),
      tsconfigPaths(),
      createHtmlPlugin({
        template: './index.html',
        inject: {
          data: {
            cspScriptSrc,
          },
        },
      }),
    // Plugin to shim Electron-only imports to empty modules in browser builds
    {
      name: 'electron-shim',
      resolveId(id) {
        if (id === '@electron-toolkit/typed-ipc/renderer' || id === '@electron-toolkit/preload') {
          return '\0electron-shim';
        }
        return null;
      },
      load(id) {
        if (id === '\0electron-shim') {
          // Export stub classes that will never be instantiated in browser mode
          return `
            export class IpcEmitter { invoke() {} send() {} }
            export class IpcListener { on() { return () => {} } once() { return () => {} } }
            export default {};
          `;
        }
        return null;
      },
    },
    ],
    root: '.',
    build: {
      outDir: 'out/browser',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve('./index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve('src'),
      },
    },
  };
});
