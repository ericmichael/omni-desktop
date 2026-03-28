import path from 'path';

const FLEET_DIR = 'fleet/tickets';
const ARTIFACTS_DIR = 'artifacts';
const CONTAINER_CONFIG_ROOT = '/home/user/.config/omni_code';

/** Host-side directory for a ticket's artifacts. */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  return path.join(configDir, FLEET_DIR, ticketId, ARTIFACTS_DIR);
};

/** Container-side path to a ticket's artifacts directory. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return path.posix.join(CONTAINER_CONFIG_ROOT, FLEET_DIR, ticketId, ARTIFACTS_DIR);
};
