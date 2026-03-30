/**
 * Simple template renderer for FLEET.md prompt templates.
 *
 * Supports Liquid-style `{{ variable }}` interpolation with dot-access for nested values.
 * Strict mode: unknown variables cause an error (fail-fast, as per Symphony spec).
 *
 * Supported variables:
 * - ticket.id, ticket.title, ticket.description, ticket.priority, ticket.columnId, ticket.branch
 * - pipeline.columns (comma-separated column labels)
 * - project.label, project.workspaceDir
 * - attempt (number or null for first run)
 */

export type TemplateVariables = {
  ticket: {
    id: string;
    title: string;
    description: string;
    priority: string;
    columnId: string;
    branch?: string;
  };
  pipeline: {
    columns: string;
  };
  project: {
    label: string;
    workspaceDir: string;
  };
  attempt: number | null;
};

export class TemplateRenderError extends Error {
  constructor(
    public variable: string,
    public template: string
  ) {
    super(`Unknown template variable: {{ ${variable} }}`);
    this.name = 'TemplateRenderError';
  }
}

/**
 * Resolve a dot-path like "ticket.title" against a variables object.
 * Returns undefined if the path doesn't resolve.
 */
const resolve = (vars: Record<string, unknown>, path: string): unknown => {
  const parts = path.split('.');
  let current: unknown = vars;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/**
 * Render a template string by replacing `{{ variable }}` expressions with values.
 * Whitespace inside braces is trimmed: `{{ticket.title}}` and `{{ ticket.title }}` both work.
 *
 * @throws TemplateRenderError if a variable reference cannot be resolved (strict mode).
 */
export const renderTemplate = (template: string, vars: TemplateVariables): string => {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, varPath: string) => {
    const value = resolve(vars as unknown as Record<string, unknown>, varPath);
    if (value === undefined) {
      throw new TemplateRenderError(varPath, template);
    }
    if (value === null) {
      return '';
    }
    return String(value);
  });
};

/**
 * Check if a template string contains any `{{ }}` expressions.
 */
export const hasTemplateExpressions = (template: string): boolean => {
  return /\{\{[^}]+\}\}/.test(template);
};
