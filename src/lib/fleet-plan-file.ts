import path from 'path';

import type { FleetPipeline, FleetTicket } from '@/shared/types';

const FLEET_DIR = 'fleet/tickets';
const ARTIFACTS_DIR = 'artifacts';
const TICKET_FILENAME = 'TICKET.yaml';
const CONTAINER_CONFIG_ROOT = '/home/user/.config/omni_code';

/** Host-side directory for a ticket. */
export const getTicketDir = (configDir: string, ticketId: string): string => {
  return path.join(configDir, FLEET_DIR, ticketId);
};

/** Host-side directory for a ticket's artifacts. */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  return path.join(configDir, FLEET_DIR, ticketId, ARTIFACTS_DIR);
};

/** Host-side path to a ticket's TICKET.yaml. */
export const getTicketFilePath = (configDir: string, ticketId: string): string => {
  return path.join(configDir, FLEET_DIR, ticketId, TICKET_FILENAME);
};

/** Container-side path to a ticket's artifacts directory. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return path.posix.join(CONTAINER_CONFIG_ROOT, FLEET_DIR, ticketId, ARTIFACTS_DIR);
};

/** Container-side path to a ticket's TICKET.yaml. */
export const getContainerTicketFilePath = (ticketId: string): string => {
  return path.posix.join(CONTAINER_CONFIG_ROOT, FLEET_DIR, ticketId, TICKET_FILENAME);
};

/**
 * Serialize a TICKET.yaml for agent consumption.
 * The agent can change `column` to move itself between pipeline columns,
 * and set `escalation` to request human attention.
 */
export const serializeTicketYaml = (ticket: FleetTicket, pipeline: FleetPipeline): string => {
  const column = pipeline.columns.find((c) => c.id === ticket.columnId);
  const columnLabel = column?.label ?? ticket.columnId ?? pipeline.columns[0]?.label ?? 'Backlog';
  const pipelineLabels = pipeline.columns.map((c) => c.label).join(' → ');

  const lines = [
    `# This file is managed by the orchestrator.`,
    `# The agent may change "column" to move the ticket through the pipeline.`,
    `# Set "escalation" to a message to pause and notify the human.`,
    `#`,
    `# Pipeline: ${pipelineLabels}`,
    ``,
    `column: "${columnLabel}"`,
  ];

  return lines.join('\n') + '\n';
};

export type ParsedTicketYaml = {
  column: string | null;
  escalation: string | null;
};

/**
 * Parse column and escalation from a TICKET.yaml written by the agent.
 */
export const parseTicketYaml = (content: string): ParsedTicketYaml => {
  const columnMatch = /^column:\s*"?([^"\n]+)"?\s*$/m.exec(content);
  const escalationMatch = /^escalation:\s*"?([^"\n]+)"?\s*$/m.exec(content);
  return {
    column: columnMatch?.[1]?.trim() ?? null,
    escalation: escalationMatch?.[1]?.trim() ?? null,
  };
};
