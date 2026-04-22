import type { SandboxBackend } from '@/shared/types';

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
 * True when the given sandbox backend keeps the agent on the host (no Linux
 * container). These backends need host paths in agent-facing instructions.
 */
export const backendRunsOnHost = (backend: SandboxBackend): boolean =>
  backend === 'none' || backend === 'local';

/**
 * Resolve the artifacts directory *as the agent will see it* — host path when
 * the agent runs on the user's machine, container path when it runs inside a
 * Linux sandbox. Use this when handing paths to the agent via prompts or
 * `additional_instructions`.
 */
export const getAgentArtifactsDir = (
  ticketId: string,
  backend: SandboxBackend,
  hostConfigDir: string
): string => {
  return backendRunsOnHost(backend)
    ? getArtifactsDir(hostConfigDir, ticketId)
    : getContainerArtifactsDir(ticketId);
};
