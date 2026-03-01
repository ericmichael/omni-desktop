import path from 'path';

import type { FleetChecklistItem, FleetPipeline, FleetTicket, FleetTicketPriority } from '@/shared/types';

// #region Path helpers

const FLEET_DIR = 'fleet/tickets';
const PLAN_FILENAME = 'PLAN.md';
const ARTIFACTS_DIR = 'artifacts';

/** Host-side directory for a ticket's plan file. Caller must supply the config dir. */
export const getPlanDir = (configDir: string, ticketId: string): string => {
  return path.join(configDir, FLEET_DIR, ticketId);
};

/** Host-side full path to a ticket's PLAN.md. */
export const getPlanPath = (configDir: string, ticketId: string): string => {
  return path.join(getPlanDir(configDir, ticketId), PLAN_FILENAME);
};

/** Host-side directory for a ticket's artifacts. */
export const getArtifactsDir = (configDir: string, ticketId: string): string => {
  return path.join(getPlanDir(configDir, ticketId), ARTIFACTS_DIR);
};

/** Container-side path to a ticket's artifacts directory. */
export const getContainerArtifactsDir = (ticketId: string): string => {
  return path.posix.join('/home/user/.config/omni_code', FLEET_DIR, ticketId, ARTIFACTS_DIR);
};

/** Container-side path visible to agents inside Docker. */
export const getContainerPlanPath = (ticketId: string): string => {
  return path.posix.join('/home/user/.config/omni_code', FLEET_DIR, ticketId, PLAN_FILENAME);
};

// #endregion

// #region Serializer

/** Find the column a ticket is currently in, falling back to first column label. */
const getCurrentColumnLabel = (ticket: FleetTicket, pipeline: FleetPipeline): string => {
  if (ticket.columnId) {
    const col = pipeline.columns.find((c) => c.id === ticket.columnId);
    if (col) {
      return col.label;
    }
  }
  return pipeline.columns[0]?.label ?? 'Backlog';
};

/**
 * Serialize a ticket + pipeline into PLAN.md content.
 *
 * Format:
 * - YAML frontmatter with id, title, priority, column
 * - `# Title` heading
 * - Description paragraph
 * - Per-column `## Label` sections with `- [x]`/`- [ ]` checklist items
 */
export const serializePlanMd = (ticket: FleetTicket, pipeline: FleetPipeline): string => {
  const columnLabel = getCurrentColumnLabel(ticket, pipeline);

  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`id: ${ticket.id}`);
  lines.push(`title: ${ticket.title}`);
  lines.push(`priority: ${ticket.priority}`);
  lines.push(`column: ${columnLabel}`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${ticket.title}`);
  lines.push('');

  // Description
  if (ticket.description) {
    lines.push(ticket.description);
    lines.push('');
  }

  // Per-column checklist sections
  for (const col of pipeline.columns) {
    const items = ticket.checklist[col.id];
    if (!items || items.length === 0) {
      continue;
    }

    lines.push(`## ${col.label}`);
    for (const item of items) {
      lines.push(`- [${item.completed ? 'x' : ' '}] ${item.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
};

// #endregion

// #region Parser

type ParsedPlanMd = {
  title: string;
  description: string;
  priority: FleetTicketPriority;
  checklist: Record<string, FleetChecklistItem[]>;
};

const VALID_PRIORITIES = new Set<string>(['low', 'medium', 'high', 'critical']);

/**
 * Parse PLAN.md content back into structured data.
 *
 * Uses the pipeline to map column labels → column IDs.
 * Generates stable-ish IDs for checklist items based on column + index.
 */
export const parsePlanMd = (content: string, pipeline: FleetPipeline): ParsedPlanMd => {
  const lines = content.split('\n');

  // Parse YAML frontmatter
  let title = '';
  let priority: FleetTicketPriority = 'medium';
  let inFrontmatter = false;
  let frontmatterEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        frontmatterEnd = i + 1;
        break;
      }
      const match = /^(\w+):\s*(.+)$/.exec(line);
      if (match) {
        const key = match[1];
        const value = match[2]!.trim();
        if (key === 'title') {
          title = value;
        }
        if (key === 'priority' && VALID_PRIORITIES.has(value)) {
          priority = value as FleetTicketPriority;
        }
      }
    }
  }

  // Build label → column ID lookup (case-insensitive)
  const labelToId = new Map<string, string>();
  for (const col of pipeline.columns) {
    labelToId.set(col.label.trim().toLowerCase(), col.id);
  }

  // Parse body after frontmatter
  let description = '';
  const checklist: Record<string, FleetChecklistItem[]> = {};
  let currentColId: string | null = null;
  let inDescription = true;

  for (let i = frontmatterEnd; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip the `# Title` heading
    if (/^# .+$/.test(line)) {
      if (!title) {
        title = line.slice(2).trim();
      }
      continue;
    }

    // ## Column heading → switch to checklist mode
    const headingMatch = /^## (.+)$/.exec(line);
    if (headingMatch) {
      inDescription = false;
      const label = (headingMatch[1] ?? '').trim().toLowerCase();
      currentColId = labelToId.get(label) ?? null;
      if (currentColId && !checklist[currentColId]) {
        checklist[currentColId] = [];
      }
      continue;
    }

    // Before first ## heading → accumulate description
    if (inDescription) {
      description += (description ? '\n' : '') + line;
      continue;
    }

    if (!currentColId) {
      continue;
    }

    // - [x] or - [ ] → checkbox item
    const itemMatch = /^- \[([ xX])\] (.+)$/.exec(line);
    if (itemMatch) {
      checklist[currentColId]!.push({
        id: `plan-${currentColId}-${checklist[currentColId]!.length}`,
        text: (itemMatch[2] ?? '').trim(),
        completed: itemMatch[1] !== ' ',
      });
      continue;
    }

    // - text (bare list item) → uncompleted checklist item
    const bareMatch = /^- (.+)$/.exec(line);
    if (bareMatch) {
      checklist[currentColId]!.push({
        id: `plan-${currentColId}-${checklist[currentColId]!.length}`,
        text: (bareMatch[1] ?? '').trim(),
        completed: false,
      });
    }
  }

  return {
    title: title.trim(),
    description: description.trim(),
    priority,
    checklist,
  };
};

// #endregion

// #region In-place checkbox updater

/**
 * Update checkbox states in an existing PLAN.md without destroying rich content.
 *
 * Walks the file line-by-line, tracks the current column via `## Label` headings,
 * and rewrites only `- [x]`/`- [ ]` lines to match the ticket's checklist state.
 * All other content (prose, file manifests, sub-headings, code blocks) passes through unchanged.
 *
 * If a column has checklist items in the ticket but no `## Label` section in the file,
 * a new section is appended at the end.
 */
export const updatePlanMdCheckboxes = (
  existingContent: string,
  ticket: FleetTicket,
  pipeline: FleetPipeline
): string => {
  const lines = existingContent.split('\n');

  // Build label → column ID lookup (case-insensitive)
  const labelToId = new Map<string, string>();
  for (const col of pipeline.columns) {
    labelToId.set(col.label.trim().toLowerCase(), col.id);
  }

  // Track which columns we've seen in the file and per-column checkbox index
  const seenColumns = new Set<string>();
  let currentColId: string | null = null;
  let checkboxIndex = 0;

  const result: string[] = [];

  for (const line of lines) {
    // Detect ## column headings
    const headingMatch = /^## (.+)$/.exec(line);
    if (headingMatch) {
      const label = (headingMatch[1] ?? '').trim().toLowerCase();
      const colId = labelToId.get(label) ?? null;
      if (colId) {
        currentColId = colId;
        seenColumns.add(colId);
        checkboxIndex = 0;
      } else {
        currentColId = null;
      }
      result.push(line);
      continue;
    }

    // If we're in a known column section and hit a checkbox line, update its state
    if (currentColId) {
      const itemMatch = /^- \[([ xX])\] (.+)$/.exec(line);
      if (itemMatch) {
        const items = ticket.checklist[currentColId] ?? [];
        const item = items[checkboxIndex];
        if (item) {
          result.push(`- [${item.completed ? 'x' : ' '}] ${item.text}`);
        } else {
          // More checkboxes in file than in ticket — preserve as-is
          result.push(line);
        }
        checkboxIndex++;
        continue;
      }

      // Bare list items that look like checklist items (no checkbox syntax)
      const bareMatch = /^- (.+)$/.exec(line);
      if (bareMatch) {
        const items = ticket.checklist[currentColId] ?? [];
        const item = items[checkboxIndex];
        if (item) {
          // Upgrade bare items to checkbox syntax using ticket state
          result.push(`- [${item.completed ? 'x' : ' '}] ${item.text}`);
        } else {
          result.push(line);
        }
        checkboxIndex++;
        continue;
      }
    }

    // Everything else passes through unchanged
    result.push(line);
  }

  // Append sections for columns that have checklist items but no ## heading in the file
  for (const col of pipeline.columns) {
    const items = ticket.checklist[col.id];
    if (!items || items.length === 0 || seenColumns.has(col.id)) {
      continue;
    }

    result.push('');
    result.push(`## ${col.label}`);
    for (const item of items) {
      result.push(`- [${item.completed ? 'x' : ' '}] ${item.text}`);
    }
  }

  return result.join('\n');
};

// #endregion
