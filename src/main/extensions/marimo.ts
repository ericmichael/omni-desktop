import { loadOmniEnvFile } from '@/main/extensions/env-file';
import type { ExtensionManifest } from '@/main/extensions/types';
import { getUVExecutablePath } from '@/main/util';

/**
 * Minimal marimo notebook seed. Marimo rewrites the file on first save, so
 * this only needs to satisfy the parser. PEP 723 inline metadata declares
 * marimo as a dependency so `--sandbox` knows what to install per notebook.
 */
export const MARIMO_NOTEBOOK_TEMPLATE = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "openai",
#     "pydantic-ai-slim",
# ]
# ///

import marimo

__generated_with = "0.0.0"
app = marimo.App(css_file="marimo-glass.css")


@app.cell
def _():
    import marimo as mo
    return (mo,)


if __name__ == "__main__":
    app.run()
`;

/**
 * Marimo extension manifest. Spawns one `uvx marimo edit` process per
 * project directory, hosting all `.py` notebooks in that dir under a single
 * server. Auth is disabled because we bind to localhost only.
 */
export const marimoManifest: ExtensionManifest = {
  id: 'marimo',
  name: 'Marimo Notebooks',
  description:
    'Reactive Python notebooks stored as plain .py files. Each notebook gets its own ' +
    'isolated environment via PEP 723 inline dependencies. First open of a notebook with ' +
    'new dependencies will resolve and download them — this can take 10-30 seconds.',
  command: {
    buildExe: () => getUVExecutablePath(),
    buildArgs: ({ cwd, port }) => [
      'tool',
      'run',
      '--from',
      'marimo',
      'marimo',
      'edit',
      cwd,
      '--headless',
      '--no-token',
      '--sandbox',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    // Forward the launcher's user-managed env file into the marimo subprocess
    // so cells can read secrets via os.environ.get(...). This is how
    // launcher → marimo connection wiring works in practice: the user puts
    // DATABRICKS_ACCESS_TOKEN/etc. in Settings → Environment, then in
    // marimo's "Add Connection" dialog clicks the 🔑 icon next to each field
    // — marimo generates os.environ.get() calls referencing those keys.
    buildEnv: () => loadOmniEnvFile(),
  },
  readiness: {
    type: 'http',
    path: '/',
    timeoutMs: 60_000,
  },
  surface: {
    type: 'webview',
    buildBaseUrl: ({ port }) => `http://127.0.0.1:${port}`,
    buildContentUrl: ({ port }, contentPath) =>
      `http://127.0.0.1:${port}/?file=${encodeURIComponent(contentPath)}`,
  },
  contentTypes: [
    {
      id: 'notebook',
      label: 'Notebook',
      fileExtension: '.py',
    },
  ],
  scope: 'per-cwd',
  idleShutdownMs: 10 * 60_000,
  initialContent: MARIMO_NOTEBOOK_TEMPLATE,
};
