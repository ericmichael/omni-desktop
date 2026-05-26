/**
 * Tests for the launcher-only client-tool definitions and `buildSessionVariables`.
 *
 * Project / ticket / milestone / page / inbox CRUD has moved to the in-process
 * MCP server (`packages/projects-mcp`). ``escalate`` / ``notify`` used to live
 * here as stubs but are now omniagents builtins (see the ``human`` capability
 * and the ``client_request`` dispatch path in ``omniagents-ui/App.tsx``).
 * Only supervisor lifecycle, UI overlays, and app/browser control remain.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSessionVariables,
  extractSafeToolNames,
  PROJECT_CLIENT_TOOLS,
} from '@/lib/client-tools';

describe('client_tools shape', () => {
  it('every tool has name, description, and parameters', () => {
    for (const tool of PROJECT_CLIENT_TOOLS) {
      expect(tool.name).toBeTypeOf('string');
      expect(tool.description).toBeTypeOf('string');
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties).toBeDefined();
    }
  });

  it('chat surface contains the launcher-only tools, no code-deck-only tools', () => {
    const vars = buildSessionVariables({ surface: 'chat' }) as {
      client_tools: { name: string }[];
      additional_instructions: string;
    };
    const names = vars.client_tools.map((t) => t.name);
    expect(names).toContain('start_ticket');
    expect(names).toContain('stop_ticket');
    expect(names).toContain('display_plan');
    expect(names).toContain('browser_list_tabsets');
    // Tools served by MCP must NOT live here
    expect(names).not.toContain('get_ticket');
    expect(names).not.toContain('move_ticket');
    expect(names).not.toContain('list_tickets');
    expect(names).not.toContain('create_ticket');
    expect(names).not.toContain('list_inbox');
    expect(names).not.toContain('create_milestone');
    // Code-only tools should NOT be in chat surface
    expect(names).not.toContain('browser_open');
    expect(vars.additional_instructions).toContain('Working with projects and tickets');
  });

  it('code surface includes code-deck-only tools', () => {
    const vars = buildSessionVariables({ surface: 'code' }) as {
      client_tools: { name: string }[];
    };
    const names = vars.client_tools.map((t) => t.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('display_plan');
    expect(names).toContain('browser_list_tabsets');
  });

  it('interactive mode uses safe_tool_names (allowlist of read-only tools)', () => {
    const vars = buildSessionVariables({ surface: 'chat' }) as {
      safe_tool_overrides: { safe_tool_names?: string[]; safe_tool_patterns?: string[] };
    };
    const overrides = vars.safe_tool_overrides;
    expect(overrides.safe_tool_names).toBeDefined();
    expect(overrides.safe_tool_patterns).toBeUndefined();
    const safeNames = overrides.safe_tool_names!;
    // App-control snapshot/list tools are read-only and stay safe
    expect(safeNames).toContain('list_apps');
    expect(safeNames).toContain('app_snapshot');
    // Mutating launcher tools must require approval
    expect(safeNames).not.toContain('escalate');
    expect(safeNames).not.toContain('start_ticket');
    expect(safeNames).not.toContain('stop_ticket');
  });

  it('autopilot mode uses safe_tool_patterns catch-all', () => {
    const vars = buildSessionVariables({ surface: 'code', autopilot: true }) as {
      safe_tool_overrides: { safe_tool_names?: string[]; safe_tool_patterns?: string[] };
    };
    expect(vars.safe_tool_overrides.safe_tool_patterns).toEqual(['.*']);
    expect(vars.safe_tool_overrides.safe_tool_names).toBeUndefined();
  });

  it('autopilot supervisorPrompt is prepended to additional_instructions', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      autopilot: true,
      supervisorPrompt: 'SUPERVISOR_PROMPT_TEXT',
    }) as { additional_instructions: string };
    expect(vars.additional_instructions.startsWith('SUPERVISOR_PROMPT_TEXT\n\n')).toBe(true);
    expect(vars.additional_instructions).toContain('Working with projects and tickets');
  });

  it('supervisorPrompt is ignored when autopilot is false', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      autopilot: false,
      supervisorPrompt: 'SHOULD_NOT_APPEAR',
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('context identifiers are present when provided', () => {
    const vars = buildSessionVariables({
      surface: 'chat',
      context: { projectId: 'proj-1', projectLabel: 'My Project', ticketId: 'tkt-1' },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('My Project');
    expect(vars.additional_instructions).toContain('proj-1');
    expect(vars.additional_instructions).toContain('tkt-1');
  });

  it('PR writeup guidance uses provided artifactsDir when passed (host mode)', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        ticketId: 'tkt-1',
        artifactsDir: '/Users/alice/.config/omni_code/tickets/tkt-1/artifacts',
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain(
      '/Users/alice/.config/omni_code/tickets/tkt-1/artifacts/pr/PR_TITLE.md'
    );
    expect(vars.additional_instructions).not.toContain('/home/user/');
  });

  it('PR writeup guidance falls back to the uniform container artifacts mount when artifactsDir is omitted', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: { ticketId: 'tkt-1' },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('/workspace/.omni-artifacts/tkt-1/pr/PR_TITLE.md');
    expect(vars.additional_instructions).not.toContain('/home/user/');
  });

  it('renders the workspace layout when sources are present', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        projectId: 'proj-1',
        sources: [
          { id: 's1', mountName: 'launcher', kind: 'local', workspaceDir: '/home/emm/Omni/Workspace/launcher' },
          { id: 's2', mountName: 'omni-code', kind: 'local', workspaceDir: '/home/emm/Omni/Workspace/omni-code' },
          { id: 's3', mountName: 'omniagents', kind: 'git-remote', repoUrl: 'https://github.com/anthropic/omniagents', defaultBranch: 'main' },
        ],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('## Workspace Layout');
    expect(vars.additional_instructions).toContain('3 sources co-mounted');
    expect(vars.additional_instructions).toContain('`/workspace/launcher/`');
    expect(vars.additional_instructions).toContain('`/workspace/omniagents/` — https://github.com/anthropic/omniagents@main (git-remote)');
  });

  it('omits the workspace layout when sources is empty', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: { projectId: 'proj-1', sources: [] },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).not.toContain('## Workspace Layout');
  });

  it('extractSafeToolNames returns only tools with safe: true', () => {
    const tools = [
      { name: 'read_thing', safe: true, description: '', parameters: { type: 'object', properties: {} } },
      { name: 'write_thing', description: '', parameters: { type: 'object', properties: {} } },
      { name: 'list_thing', safe: true, description: '', parameters: { type: 'object', properties: {} } },
    ] as const;
    expect(extractSafeToolNames(tools)).toEqual(['read_thing', 'list_thing']);
  });

  it('start_ticket and stop_ticket each require ticket_id', () => {
    const start = PROJECT_CLIENT_TOOLS.find((t) => t.name === 'start_ticket')!;
    const stop = PROJECT_CLIENT_TOOLS.find((t) => t.name === 'stop_ticket')!;
    expect(start.parameters.required).toEqual(['ticket_id']);
    expect(stop.parameters.required).toEqual(['ticket_id']);
  });
});
