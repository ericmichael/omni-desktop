/**
 * Public, IPC-safe extension types.
 *
 * Manifests with functions live in `src/main/extensions/` and never cross the
 * IPC boundary. The renderer only ever sees these data-only descriptors and
 * status snapshots.
 */

export type ExtensionId = string;

/**
 * A content type contributed by an extension. Drives "New …" menus in the
 * sidebar and which renderer surface is mounted when a page of this kind is
 * opened. The launcher's Page table stores the contributing kind on
 * `Page.kind`; the file extension here decides the on-disk suffix.
 */
export type ExtensionContentType = {
  /** Stable identifier, e.g. 'notebook'. Matches values used in Page.kind. */
  id: string;
  label: string;
  /** Includes the leading dot, e.g. '.py'. */
  fileExtension: string;
};

export type ExtensionDescriptor = {
  id: ExtensionId;
  name: string;
  description: string;
  enabled: boolean;
  contentTypes: ExtensionContentType[];
};

/**
 * Lifecycle state of one extension instance. An instance is a single running
 * subprocess scoped to a working directory (typically a project folder).
 */
export type ExtensionInstanceState =
  | { state: 'idle' }
  | { state: 'starting'; port: number }
  | { state: 'running'; port: number; url: string; pid: number; startedAt: number }
  | { state: 'error'; error: string; lastStderr: string };

export type ExtensionEnsureResult = {
  url: string;
  port: number;
};
