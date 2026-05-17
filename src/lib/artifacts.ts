const TICKETS_DIR = 'tickets';
const ARTIFACTS_DIR = 'artifacts';
const CONTAINER_CONFIG_ROOT = '/home/user/.config/omni_code';

/**
 * Host-side directory for a ticket's artifacts. Joins with forward slashes —
 * Node's fs + child_process accept those on every OS, and the result is also
 * safe to include in agent-facing prompts. This keeps the module importable
 * from the renderer (no `path` dependency).
 */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  const trimmed = configDir.replace(/[\\/]+$/, '');
  return `${trimmed}/${TICKETS_DIR}/${ticketId}/${ARTIFACTS_DIR}`;
};

/** Container-side path to a ticket's artifacts directory. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return `${CONTAINER_CONFIG_ROOT}/${TICKETS_DIR}/${ticketId}/${ARTIFACTS_DIR}`;
};

/**
 * True when the resolved profile keeps the workspace on the host filesystem
 * (currently just ``host`` → unix_local with the workspace dir as root).
 * Anything else (``devbox``, ``platform``, future custom profiles) puts the
 * workspace inside a container, so artifact paths must use the container layout.
 */
export const profileRunsOnHost = (profileName: string): boolean => profileName === 'host';

/**
 * Resolve the artifacts directory *as the agent will see it* — host path when
 * the profile keeps the workspace on the host, container path otherwise. Use
 * this when handing paths to the agent via prompts or
 * `additional_instructions`.
 */
export const getAgentArtifactsDir = (
  ticketId: string,
  profileName: string,
  hostConfigDir: string
): string => {
  return profileRunsOnHost(profileName)
    ? getArtifactsDir(hostConfigDir, ticketId)
    : getContainerArtifactsDir(ticketId);
};
