import { describe, expect, it } from 'vitest';

import { parseWorkflow } from './workflow';

describe('parseWorkflow', () => {
  it('parses empty content as empty config with empty prompt', () => {
    const result = parseWorkflow('');
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('');
  });

  it('parses content without frontmatter as prompt-only', () => {
    const result = parseWorkflow('You are a supervisor agent.\n\nDo good work.');
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('You are a supervisor agent.\n\nDo good work.');
  });

  it('parses frontmatter with supervisor config', () => {
    const content = `---
supervisor:
  max_concurrent: 3
  stall_timeout_ms: 600000
  max_retry_attempts: 2
  max_continuation_turns: 5
---

Custom prompt here.`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor).toEqual({
      max_concurrent: 3,
      stall_timeout_ms: 600000,
      max_retry_attempts: 2,
      max_continuation_turns: 5,
    });
    expect(result.promptTemplate).toBe('Custom prompt here.');
  });

  it('parses hooks config with inline values', () => {
    const content = `---
hooks:
  before_run: npm install && npm run build
  after_run: npm test
  timeout_ms: 30000
---`;

    const result = parseWorkflow(content);
    expect(result.config.hooks).toEqual({
      before_run: 'npm install && npm run build',
      after_run: 'npm test',
      timeout_ms: 30000,
    });
    expect(result.promptTemplate).toBe('');
  });

  it('parses multiline hook scripts using block scalar', () => {
    const content = `---
hooks:
  before_run: |
    npm install
    npm run build
    echo "ready"
---

Prompt body.`;

    const result = parseWorkflow(content);
    expect(result.config.hooks?.before_run).toBe('npm install\nnpm run build\necho "ready"');
    expect(result.promptTemplate).toBe('Prompt body.');
  });

  it('ignores invalid numeric values', () => {
    const content = `---
supervisor:
  max_concurrent: not_a_number
  stall_timeout_ms: -100
  max_retry_attempts: 0
---`;

    const result = parseWorkflow(content);
    // All invalid — supervisor object should be created but empty
    expect(result.config.supervisor).toEqual({});
  });

  it('handles unclosed frontmatter as prompt-only', () => {
    const content = `---
supervisor:
  max_concurrent: 3
Some text without closing frontmatter`;

    const result = parseWorkflow(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toContain('---');
  });

  it('parses both supervisor and hooks sections', () => {
    const content = `---
supervisor:
  max_concurrent: 2
hooks:
  before_run: make build
---

Be careful with this project.`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor?.max_concurrent).toBe(2);
    expect(result.config.hooks?.before_run).toBe('make build');
    expect(result.promptTemplate).toBe('Be careful with this project.');
  });

  it('parses auto_dispatch boolean', () => {
    const content = `---
supervisor:
  auto_dispatch: true
  max_concurrent: 3
---`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor?.auto_dispatch).toBe(true);
    expect(result.config.supervisor?.max_concurrent).toBe(3);
  });

  it('parses per-column concurrency limits', () => {
    const content = `---
max_concurrent_by_column:
  spec: 1
  implementation: 3
  review: 2
---`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor?.max_concurrent_by_column).toEqual({
      spec: 1,
      implementation: 3,
      review: 2,
    });
  });

  it('parses after_create and before_remove hooks', () => {
    const content = `---
hooks:
  after_create: npm install
  before_run: npm run build
  after_run: npm test
  before_remove: npm run cleanup
  timeout_ms: 30000
---`;

    const result = parseWorkflow(content);
    expect(result.config.hooks).toEqual({
      after_create: 'npm install',
      before_run: 'npm run build',
      after_run: 'npm test',
      before_remove: 'npm run cleanup',
      timeout_ms: 30000,
    });
  });

  it('ignores invalid per-column concurrency values', () => {
    const content = `---
max_concurrent_by_column:
  spec: 0
  implementation: -1
  review: not_a_number
  pr: 2
---`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor?.max_concurrent_by_column).toEqual({
      pr: 2,
    });
  });

  it('parses pipeline columns', () => {
    const content = `---
pipeline:
  columns:
    - id: todo
      label: To Do
    - id: doing
      label: Doing
    - id: done
      label: Done
---`;

    const result = parseWorkflow(content);
    expect(result.config.pipeline).toEqual({
      columns: [
        { id: 'todo', label: 'To Do' },
        { id: 'doing', label: 'Doing' },
        { id: 'done', label: 'Done' },
      ],
    });
  });

  it('parses pipeline columns with checklists', () => {
    const content = `---
pipeline:
  columns:
    - id: backlog
      label: Backlog
    - id: build
      label: Build
      checklist:
        - All tests pass
        - No lint errors
    - id: done
      label: Done
---`;

    const result = parseWorkflow(content);
    expect(result.config.pipeline?.columns).toHaveLength(3);
    expect(result.config.pipeline?.columns[1]).toEqual({
      id: 'build',
      label: 'Build',
      checklist: ['All tests pass', 'No lint errors'],
    });
    expect(result.config.pipeline?.columns[0]).toEqual({ id: 'backlog', label: 'Backlog' });
  });

  it('parses pipeline alongside other sections', () => {
    const content = `---
supervisor:
  max_concurrent: 2
pipeline:
  columns:
    - id: todo
      label: Todo
    - id: done
      label: Done
hooks:
  before_run: npm test
---

Custom prompt.`;

    const result = parseWorkflow(content);
    expect(result.config.supervisor?.max_concurrent).toBe(2);
    expect(result.config.pipeline?.columns).toHaveLength(2);
    expect(result.config.hooks?.before_run).toBe('npm test');
    expect(result.promptTemplate).toBe('Custom prompt.');
  });

  it('returns undefined pipeline for empty columns section', () => {
    const content = `---
pipeline:
  columns:
---`;

    const result = parseWorkflow(content);
    expect(result.config.pipeline).toBeUndefined();
  });
});
