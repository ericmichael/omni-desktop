const TICKETS_DIR = 'tickets';
const ARTIFACTS_DIR = 'artifacts';

/** Workspace root inside every containerized profile (the manifest root that
 *  sources are seeded under and that the SDK snapshot captures). */
const CONTAINER_WORKSPACE_ROOT = '/workspace';

/**
 * Artifacts directory name, kept *inside* the workspace root as a dot-dir
 * sibling of the source mounts (`<workspace>/.omni-artifacts/<ticketId>`). It
 * rides the workspace's existing persistence for free — the docker snapshot tar
 * (devbox) and the Azure Files workspace share (ACI) both capture it — so a
 * ticket's artifacts survive sandbox switches the same way its sources do. The
 * leading dot keeps it out of the per-source seed/diff loop (which globs the
 * non-dot subdirs of the workspace), so it never pollutes a reviewed git tree.
 */
export const ARTIFACTS_DIRNAME = '.omni-artifacts';

/**
 * Host-side directory for a ticket's artifacts. Joins with forward slashes —
 * Node's fs + child_process accept those on every OS, and the result is also
 * safe to include in agent-facing prompts. This keeps the module importable
 * from the renderer (no `path` dependency). Used directly by the `host` profile
 * (agent runs on the host fs) and as the read/cache base for container profiles.
 */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  const trimmed = configDir.replace(/[\\/]+$/, '');
  return `${trimmed}/${TICKETS_DIR}/${ticketId}/${ARTIFACTS_DIR}`;
};

/** Per-ticket artifacts dir *inside a container*, under the workspace root. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return `${CONTAINER_WORKSPACE_ROOT}/${ARTIFACTS_DIRNAME}/${ticketId}`;
};

/**
 * True when the resolved profile keeps the workspace on the host filesystem
 * (currently just ``host`` → unix_local with the workspace dir as root).
 * Anything else (``devbox``, ``platform``, future custom profiles) puts the
 * workspace inside a container, so artifact paths must use the container layout.
 */
export const profileRunsOnHost = (profileName: string): boolean => profileName === 'host';
