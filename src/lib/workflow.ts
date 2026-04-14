/**
 * FLEET.md workflow file parser and types.
 *
 * Inspired by Symphony's WORKFLOW.md: a markdown file with YAML frontmatter
 * for runtime settings and a markdown body for the supervisor prompt template.
 *
 * Located at `<project.workspaceDir>/FLEET.md`.
 *
 * Example:
 * ```markdown
 * ---
 * supervisor:
 *   max_concurrent: 3
 *   stall_timeout_ms: 600000
 *   max_retry_attempts: 3
 *   max_continuation_turns: 8
 * hooks:
 *   before_run: |
 *     npm install
 *     npm run build
 *   after_run: |
 *     npm test
 *   timeout_ms: 60000
 * ---
 *
 * You are a supervisor agent for this project...
 * (custom prompt instructions here)
 * ```
 */

// #region Types

export type WorkflowColumnDef = {
  id: string;
  label: string;
  checklist?: string[];
  gate?: boolean;
};

export type WorkflowConfig = {
  supervisor?: {
    max_concurrent?: number;
    stall_timeout_ms?: number;
    max_retry_attempts?: number;
    max_continuation_turns?: number;
    auto_dispatch?: boolean;
    /** Per-column concurrency limits. Keys are column IDs, values are positive integers. */
    max_concurrent_by_column?: Record<string, number>;
    /** Custom continuation prompt template. Supports {{turn}}, {{maxTurns}} placeholders. */
    continuation_prompt?: string;
  };
  /** Custom pipeline columns. Overrides the project's stored pipeline when present. */
  pipeline?: {
    columns: WorkflowColumnDef[];
  };
  hooks?: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
    timeout_ms?: number;
  };
};

export type Workflow = {
  /** Parsed YAML frontmatter config. */
  config: WorkflowConfig;
  /** Markdown body after frontmatter — the prompt template. Empty string if no body. */
  promptTemplate: string;
};

// #endregion

// #region Parser

/**
 * Parse a FLEET.md file content into config + prompt template.
 *
 * Uses a simple line-based YAML parser (no external deps) since the schema
 * is small and well-defined. Supports nested keys one level deep with indentation.
 */
export const parseWorkflow = (content: string): Workflow => {
  const lines = content.split('\n');

  // Check for YAML frontmatter
  if (!lines[0] || lines[0].trim() !== '---') {
    // No frontmatter — entire file is the prompt template
    return { config: {}, promptTemplate: content.trim() };
  }

  // Find closing ---
  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      frontmatterEnd = i;
      break;
    }
  }

  if (frontmatterEnd === -1) {
    // Unclosed frontmatter — treat entire file as prompt
    return { config: {}, promptTemplate: content.trim() };
  }

  const frontmatterLines = lines.slice(1, frontmatterEnd);
  const promptBody = lines.slice(frontmatterEnd + 1).join('\n').trim();

  const config = parseFrontmatter(frontmatterLines);

  return { config, promptTemplate: promptBody };
};

/**
 * Simple YAML-subset parser for FLEET.md frontmatter.
 * Supports top-level keys with nested object values (one level of indentation).
 * Also handles multiline string values using `|` (block scalar).
 * The `pipeline` section uses a dedicated parser for array-of-objects syntax.
 */
const parseFrontmatter = (lines: string[]): WorkflowConfig => {
  const config: WorkflowConfig = {};

  let currentSection: string | null = null;
  let collectingMultiline: { section: string; key: string; lines: string[] } | null = null;
  // Accumulate lines for the pipeline section and parse them at the end
  let pipelineLines: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // If we're inside the pipeline section, accumulate lines until we hit a new top-level key
    if (pipelineLines !== null) {
      // Top-level key (no indentation) ends the pipeline section
      if (/^\w+:\s*/.test(line)) {
        config.pipeline = parsePipelineSection(pipelineLines);
        pipelineLines = null;
        // Fall through to parse this line normally
      } else {
        pipelineLines.push(line);
        continue;
      }
    }

    // If we're collecting a multiline block scalar, check indentation
    if (collectingMultiline) {
      // Multiline continues while lines are indented (at least 4 spaces)
      if (/^ {4,}/.test(line) || (line.trim() === '' && collectingMultiline.lines.length > 0)) {
        collectingMultiline.lines.push(line.replace(/^ {4}/, ''));
        continue;
      } else {
        // End of multiline block — apply collected value
        applyValue(config, collectingMultiline.section, collectingMultiline.key, collectingMultiline.lines.join('\n').trim());
        collectingMultiline = null;
      }
    }

    // Skip empty lines
    if (line.trim() === '') {
      continue;
    }

    // Top-level key (no indentation): `section:`
    const topMatch = /^(\w+):\s*$/.exec(line);
    if (topMatch) {
      currentSection = topMatch[1]!;
      if (currentSection === 'pipeline') {
        pipelineLines = [];
        continue;
      }
      continue;
    }

    // Top-level key with value: `key: value` (no nesting)
    const topValueMatch = /^(\w+):\s+(.+)$/.exec(line);
    if (topValueMatch && !currentSection) {
      continue; // Skip unknown top-level values
    }

    // Nested key: `  key: value` or `  key: |`
    if (currentSection) {
      const nestedMatch = /^ {2}(\w+):\s*(.*)$/.exec(line);
      if (nestedMatch) {
        const key = nestedMatch[1]!;
        const value = nestedMatch[2]!.trim();

        if (value === '|') {
          // Start multiline block scalar
          collectingMultiline = { section: currentSection, key, lines: [] };
        } else if (value) {
          applyValue(config, currentSection, key, value);
        }
      }
    }
  }

  // Flush any remaining multiline block
  if (collectingMultiline) {
    applyValue(config, collectingMultiline.section, collectingMultiline.key, collectingMultiline.lines.join('\n').trim());
  }

  // Flush any remaining pipeline section
  if (pipelineLines !== null) {
    config.pipeline = parsePipelineSection(pipelineLines);
  }

  return config;
};

/**
 * Parse the pipeline section from FLEET.md frontmatter.
 *
 * Expected format:
 * ```yaml
 *   columns:
 *     - id: backlog
 *       label: Backlog
 *     - id: build
 *       label: Build
 *       checklist:
 *         - All tests pass
 *         - No lint errors
 * ```
 */
const parsePipelineSection = (lines: string[]): WorkflowConfig['pipeline'] => {
  const columns: WorkflowColumnDef[] = [];
  let current: Partial<WorkflowColumnDef> | null = null;
  let collectingChecklist = false;

  const flushColumn = () => {
    if (current?.id && current.label) {
      columns.push({
        id: current.id,
        label: current.label,
        ...(current.checklist && current.checklist.length > 0 ? { checklist: current.checklist } : {}),
        ...(current.gate ? { gate: true } : {}),
      });
    }
    current = null;
    collectingChecklist = false;
  };

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') {
      continue;
    }

    // `  columns:` header — skip
    if (/^ {2}columns:\s*$/.test(line)) {
      continue;
    }

    // New column item: `    - id: value`
    const itemStart = /^ {4}- (\w+):\s*(.+)$/.exec(line);
    if (itemStart) {
      flushColumn();
      current = { [itemStart[1]!]: itemStart[2]!.trim() };
      collectingChecklist = false;
      continue;
    }

    // Column property: `      key: value`
    const propMatch = /^ {6}(\w+):\s*(.*)$/.exec(line);
    if (propMatch && current) {
      const key = propMatch[1]!;
      const value = propMatch[2]!.trim();

      if (key === 'checklist' && !value) {
        collectingChecklist = true;
      } else if (key === 'id' || key === 'label') {
        current[key] = value;
      } else if (key === 'gate') {
        current.gate = value === 'true';
      }
      continue;
    }

    // Checklist item: `        - text`
    const checklistItem = /^ {8}- (.+)$/.exec(line);
    if (checklistItem && current && collectingChecklist) {
      if (!current.checklist) {
        current.checklist = [];
      }
      current.checklist.push(checklistItem[1]!.trim());
      continue;
    }
  }

  flushColumn();

  if (columns.length === 0) {
    return undefined;
  }

  return { columns };
};

const applyValue = (config: WorkflowConfig, section: string, key: string, value: string): void => {
  if (section === 'supervisor') {
    if (!config.supervisor) {
      config.supervisor = {};
    }
    const numValue = Number(value);
    switch (key) {
      case 'max_concurrent':
        if (!isNaN(numValue) && numValue > 0) {
config.supervisor.max_concurrent = numValue;
}
        break;
      case 'stall_timeout_ms':
        if (!isNaN(numValue) && numValue > 0) {
config.supervisor.stall_timeout_ms = numValue;
}
        break;
      case 'max_retry_attempts':
        if (!isNaN(numValue) && numValue > 0) {
config.supervisor.max_retry_attempts = numValue;
}
        break;
      case 'max_continuation_turns':
        if (!isNaN(numValue) && numValue > 0) {
config.supervisor.max_continuation_turns = numValue;
}
        break;
      case 'auto_dispatch':
        config.supervisor.auto_dispatch = value === 'true';
        break;
      case 'continuation_prompt':
        if (value) {
config.supervisor.continuation_prompt = value;
}
        break;
    }
  } else if (section === 'max_concurrent_by_column') {
    if (!config.supervisor) {
      config.supervisor = {};
    }
    if (!config.supervisor.max_concurrent_by_column) {
      config.supervisor.max_concurrent_by_column = {};
    }
    const numValue = Number(value);
    if (!isNaN(numValue) && numValue > 0) {
      config.supervisor.max_concurrent_by_column[key] = numValue;
    }
  } else if (section === 'hooks') {
    if (!config.hooks) {
      config.hooks = {};
    }
    switch (key) {
      case 'after_create':
        config.hooks.after_create = value;
        break;
      case 'before_run':
        config.hooks.before_run = value;
        break;
      case 'after_run':
        config.hooks.after_run = value;
        break;
      case 'before_remove':
        config.hooks.before_remove = value;
        break;
      case 'timeout_ms': {
        const numValue = Number(value);
        if (!isNaN(numValue) && numValue > 0) {
config.hooks.timeout_ms = numValue;
}
        break;
      }
    }
  }
};

// #endregion
