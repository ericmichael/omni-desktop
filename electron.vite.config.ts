import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'electron-vite';
import { resolve } from 'path';
import { createHtmlPlugin } from 'vite-plugin-html';
import tsconfigPaths from 'vite-tsconfig-paths';

// Enterprise builds set OMNI_PLATFORM_URL at build time to bake in
// the management plane endpoint. Open-source builds leave it unset.
const platformDefines = {
  __PLATFORM_URL__: JSON.stringify(process.env.OMNI_PLATFORM_URL || ''),
};

export default defineConfig({
  main: {
    plugins: [tsconfigPaths()],
    define: platformDefines,
    build: {
      lib: {
        entry: resolve('src/main/index.ts'),
      },
      rollupOptions: {
        external: ['node-pty'],
      },
    },
  },
  preload: {
    plugins: [tsconfigPaths()],
    build: {
      lib: {
        entry: resolve('src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: '.',
    define: platformDefines,
    plugins: [
      tailwindcss(),
      react(),
      tsconfigPaths(),
      createHtmlPlugin({
        // index.dev.html has react devtools
        template: process.env.NODE_ENV === 'development' ? './index.dev.html' : './index.html',
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('./index.html'),
        },
      },
    },
  },
});
