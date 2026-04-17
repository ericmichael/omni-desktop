import path from 'path';

const TICKETS_DIR = 'tickets';
const ARTIFACTS_DIR = 'artifacts';
const CONTAINER_CONFIG_ROOT = '/home/user/.config/omni_code';

/** Host-side directory for a ticket's artifacts. */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  return path.join(configDir, TICKETS_DIR, ticketId, ARTIFACTS_DIR);
};

/** Container-side path to a ticket's artifacts directory. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return `${CONTAINER_CONFIG_ROOT}/${TICKETS_DIR}/${ticketId}/${ARTIFACTS_DIR}`;
};
