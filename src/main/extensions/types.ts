import type { ExtensionContentType, ExtensionId } from '@/shared/extensions';

/**
 * Function-bearing manifest. Lives main-side only — never crosses IPC.
 * Renderers see a stripped `ExtensionDescriptor` instead.
 */
export type ExtensionInstanceContext = {
  cwd: string;
  port: number;
};

export type ExtensionManifest = {
  id: ExtensionId;
  name: string;
  description: string;
  command: {
    buildExe: () => string;
    buildArgs: (ctx: ExtensionInstanceContext) => string[];
    /**
     * Optional hook to provide environment variables for the spawned
     * subprocess. Called once per spawn; the result is merged on top of
     * `process.env`. Used e.g. by marimo to forward the launcher's
     * Settings → Environment file into the notebook runtime so cells can
     * reference secrets via `os.environ.get(...)`.
     */
    buildEnv?: (ctx: ExtensionInstanceContext) => Promise<Record<string, string>>;
  };
  readiness: {
    type: 'http';
    /** Path appended to the base URL when probing readiness. */
    path: string;
    timeoutMs: number;
  };
  surface: {
    type: 'webview';
    /** Renderer-facing URL for the bare instance (no specific content). */
    buildBaseUrl: (ctx: ExtensionInstanceContext) => string;
    /** Renderer-facing URL for opening a specific content file. */
    buildContentUrl: (ctx: ExtensionInstanceContext, contentPath: string) => string;
  };
  contentTypes: ExtensionContentType[];
  /** Only 'per-cwd' is supported today. One subprocess per (extensionId, cwd). */
  scope: 'per-cwd';
  /** Milliseconds of zero refcount before the subprocess is shut down. */
  idleShutdownMs: number;
  /** Initial content seeded into a new content file (e.g. notebook template). */
  initialContent?: string;
};
