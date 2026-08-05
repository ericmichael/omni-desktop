import { cpSync, createReadStream, existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Serves Excalidraw's font assets locally so drawings render offline.
 *
 * Excalidraw loads fonts at runtime via `new FontFace(family, url)` where the
 * url is built from `window.EXCALIDRAW_ASSET_PATH` (set in the renderer entry)
 * as `<assetPath>/fonts/...`. Those URLs are constructed at runtime, so the
 * bundler never sees them and won't copy the fonts automatically. This plugin
 * bridges that gap for both the Electron renderer and the browser SPA:
 *
 *  - dev: a middleware streams `/excalidraw-assets/fonts/*` straight from the
 *    installed `@excalidraw/excalidraw` package.
 *  - build: the package's `dist/prod/fonts` dir is copied into the build
 *    output under `excalidraw-assets/fonts` so the packaged app is offline.
 *
 * `window.EXCALIDRAW_ASSET_PATH` must therefore be `/excalidraw-assets/`.
 */
export const EXCALIDRAW_ASSET_BASE = '/excalidraw-assets/';

function resolveFontsDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // Resolve the package main (dist/prod/index.js); fonts sit beside it.
    const mainPath = require.resolve('@excalidraw/excalidraw');
    const fonts = resolve(dirname(mainPath), 'fonts');
    return existsSync(fonts) ? fonts : null;
  } catch {
    return null;
  }
}

export function excalidrawAssets(): Plugin {
  let config: ResolvedConfig;
  const fontsDir = resolveFontsDir();

  return {
    name: 'excalidraw-assets',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      if (!fontsDir) {
        return;
      }
      const prefix = `${EXCALIDRAW_ASSET_BASE}fonts/`;
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(prefix)) {
          return next();
        }
        // Strip query string and prevent path traversal.
        const rel = decodeURIComponent(req.url.slice(prefix.length).split('?')[0]);
        const filePath = resolve(fontsDir, rel);
        if (!filePath.startsWith(fontsDir) || !existsSync(filePath)) {
          return next();
        }
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(filePath).pipe(res);
      });
    },
    closeBundle() {
      if (!fontsDir || !config?.build?.outDir) {
        return;
      }
      const dest = join(resolve(config.root, config.build.outDir), 'excalidraw-assets', 'fonts');
      cpSync(fontsDir, dest, { recursive: true });
    },
  };
}
