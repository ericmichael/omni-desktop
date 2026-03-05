import { describe, expect, it } from 'vitest';

import { hasTemplateExpressions, renderTemplate, TemplateRenderError } from './fleet-template';
import type { TemplateVariables } from './fleet-template';

const makeVars = (overrides?: Partial<TemplateVariables>): TemplateVariables => ({
  ticket: {
    id: 'tkt-1',
    title: 'Add auth module',
    description: 'Implement JWT-based authentication',
    priority: 'high',
    columnId: 'implementation',
    branch: 'feat/auth',
  },
  pipeline: {
    columns: 'Backlog → Spec → Implementation → Review → PR → Completed',
  },
  project: {
    label: 'My Project',
    workspaceDir: '/home/user/project',
  },
  attempt: null,
  checklist: {
    spec: '- [x] Define API surface',
    implementation: '- [ ] Create auth service\n- [ ] Add JWT validation',
    review: '(none)',
  },
  ...overrides,
});

describe('renderTemplate', () => {
  it('replaces simple ticket variables', () => {
    const result = renderTemplate('Title: {{ ticket.title }}, Priority: {{ ticket.priority }}', makeVars());
    expect(result).toBe('Title: Add auth module, Priority: high');
  });

  it('replaces project and pipeline variables', () => {
    const result = renderTemplate(
      'Project: {{ project.label }} at {{ project.workspaceDir }}\nPipeline: {{ pipeline.columns }}',
      makeVars()
    );
    expect(result).toContain('Project: My Project at /home/user/project');
    expect(result).toContain('Pipeline: Backlog → Spec → Implementation');
  });

  it('replaces checklist variables by column ID', () => {
    const result = renderTemplate('Spec checklist:\n{{ checklist.spec }}', makeVars());
    expect(result).toBe('Spec checklist:\n- [x] Define API surface');
  });

  it('renders attempt as empty string when null', () => {
    const result = renderTemplate('Attempt: {{ attempt }}', makeVars());
    expect(result).toBe('Attempt: ');
  });

  it('renders attempt as number when set', () => {
    const result = renderTemplate('Attempt: {{ attempt }}', makeVars({ attempt: 3 }));
    expect(result).toBe('Attempt: 3');
  });

  it('handles whitespace variations in braces', () => {
    const result = renderTemplate('{{ticket.title}} / {{  ticket.priority  }}', makeVars());
    expect(result).toBe('Add auth module / high');
  });

  it('throws TemplateRenderError on unknown variable', () => {
    expect(() => renderTemplate('{{ ticket.unknown_field }}', makeVars())).toThrow(TemplateRenderError);
  });

  it('includes variable name in error', () => {
    try {
      renderTemplate('{{ nonexistent.path }}', makeVars());
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRenderError);
      expect((err as TemplateRenderError).variable).toBe('nonexistent.path');
    }
  });

  it('passes through text without template expressions unchanged', () => {
    const plain = 'Just plain text with no variables.';
    expect(renderTemplate(plain, makeVars())).toBe(plain);
  });

  it('handles optional ticket.branch', () => {
    const result = renderTemplate('Branch: {{ ticket.branch }}', makeVars());
    expect(result).toBe('Branch: feat/auth');
  });

  it('renders undefined branch as unknown variable error', () => {
    const vars = makeVars();
    vars.ticket.branch = undefined;
    expect(() => renderTemplate('{{ ticket.branch }}', vars)).toThrow(TemplateRenderError);
  });

  it('handles multiple expressions on one line', () => {
    const result = renderTemplate(
      '{{ ticket.id }}: {{ ticket.title }} [{{ ticket.priority }}]',
      makeVars()
    );
    expect(result).toBe('tkt-1: Add auth module [high]');
  });
});

describe('hasTemplateExpressions', () => {
  it('returns true for templates with expressions', () => {
    expect(hasTemplateExpressions('Hello {{ ticket.title }}')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasTemplateExpressions('Hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasTemplateExpressions('')).toBe(false);
  });

  it('returns false for single braces', () => {
    expect(hasTemplateExpressions('{ not a template }')).toBe(false);
  });
});
