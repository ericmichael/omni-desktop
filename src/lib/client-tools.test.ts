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

import { buildSessionVariables, extractSafeToolNames, PROJECT_CLIENT_TOOLS } from '@/lib/client-tools';

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

  it('global surface includes the workspace-orchestrator tools plus everything code has', () => {
    const vars = buildSessionVariables({ surface: 'global' }) as {
      client_tools: { name: string }[];
      additional_instructions: string;
    };
    const names = vars.client_tools.map((t) => t.name);
    // workspace-superuser tools
    expect(names).toContain('list_workspace');
    expect(names).toContain('open_column');
    expect(names).toContain('close_column');
    expect(names).toContain('column_send');
    expect(names).toContain('column_decide');
    expect(names).toContain('column_cancel');
    expect(names).toContain('column_transcript');
    expect(names).toContain('column_read_entry');
    expect(names).toContain('terminal_send_keys');
    expect(names).toContain('terminal_capture');
    expect(names).toContain('terminal_list');
    expect(names).toContain('terminal_open');
    expect(names).toContain('launch_app');
    // inherits code + chat tools
    expect(names).toContain('browser_open');
    expect(names).toContain('list_apps');
    expect(names).toContain('start_ticket');
    // role guidance present
    expect(vars.additional_instructions).toContain('workspace orchestrator');
  });

  it('launch_app is available on the code surface, not chat', () => {
    const code = buildSessionVariables({ surface: 'code' }) as { client_tools: { name: string }[] };
    const chat = buildSessionVariables({ surface: 'chat' }) as { client_tools: { name: string }[] };
    expect(code.client_tools.map((t) => t.name)).toContain('launch_app');
    expect(chat.client_tools.map((t) => t.name)).not.toContain('launch_app');
  });

  it('workspace tools are absent from chat and code surfaces', () => {
    for (const surface of ['chat', 'code'] as const) {
      const names = (buildSessionVariables({ surface }) as { client_tools: { name: string }[] }).client_tools.map(
        (t) => t.name
      );
      expect(names).not.toContain('list_workspace');
      expect(names).not.toContain('column_send');
    }
  });

  it('global surface keeps close_column behind approval but column_* + launch_app safe', () => {
    const vars = buildSessionVariables({ surface: 'global' }) as {
      safe_tool_overrides: { safe_tool_names?: string[] };
    };
    const safe = vars.safe_tool_overrides.safe_tool_names!;
    expect(safe).toContain('list_workspace');
    expect(safe).toContain('launch_app');
    expect(safe).toContain('column_send');
    expect(safe).toContain('column_cancel');
    // destructive workspace mutation must require approval
    expect(safe).not.toContain('close_column');
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

  it('plain-folder sources get deliverables-in-the-folder guidance, no artifacts channel', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        projectId: 'proj-1',
        ticketId: 'tkt-1',
        sources: [{ id: 's1', mountName: 'notes', kind: 'local', workspaceDir: '/home/u/notes' }],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('## Where to put output for the user');
    expect(vars.additional_instructions).toContain('`/workspace/notes/`');
    expect(vars.additional_instructions).not.toContain('.omni-artifacts');
    expect(vars.additional_instructions).not.toContain('PR_TITLE');
  });

  it('repo sources get the artifacts channel using the provided artifactsDir (host mode)', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        ticketId: 'tkt-1',
        artifactsDir: '/Users/alice/.config/omni_code/tickets/tkt-1/artifacts',
        sources: [{ id: 's1', mountName: 'repo', kind: 'local', workspaceDir: '/home/u/repo', gitDetected: true }],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('/Users/alice/.config/omni_code/tickets/tkt-1/artifacts');
    expect(vars.additional_instructions).toContain('gh pr create');
    expect(vars.additional_instructions).not.toContain('PR_TITLE');
  });

  it('repo artifacts guidance falls back to the uniform container artifacts mount when artifactsDir is omitted', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        ticketId: 'tkt-1',
        sources: [{ id: 's1', mountName: 'lib', kind: 'git-remote', repoUrl: 'https://github.com/acme/lib' }],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('/workspace/.omni-artifacts/tkt-1');
    expect(vars.additional_instructions).not.toContain('PR_TITLE');
  });

  it('repo sources without a ticket get keep-the-repo-clean guidance instead of an artifacts dir', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        projectId: 'proj-1',
        sources: [{ id: 's1', mountName: 'lib', kind: 'git-remote', repoUrl: 'https://github.com/acme/lib' }],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('share results in your reply');
    expect(vars.additional_instructions).not.toContain('.omni-artifacts');
  });

  it('a bare workspaceDir (chat scratch) gets working-folder guidance', () => {
    const vars = buildSessionVariables({
      surface: 'chat',
      context: { workspaceDir: '/home/u/Omni/Workspace/Sessions/abc' },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('## Where to put output for the user');
    expect(vars.additional_instructions).toContain('working folder');
    expect(vars.additional_instructions).not.toContain('.omni-artifacts');
  });

  it('renders the workspace layout when sources are present', () => {
    const vars = buildSessionVariables({
      surface: 'code',
      context: {
        projectId: 'proj-1',
        sources: [
          { id: 's1', mountName: 'launcher', kind: 'local', workspaceDir: '/home/emm/Omni/Workspace/launcher' },
          { id: 's2', mountName: 'omni-code', kind: 'local', workspaceDir: '/home/emm/Omni/Workspace/omni-code' },
          {
            id: 's3',
            mountName: 'omniagents',
            kind: 'git-remote',
            repoUrl: 'https://github.com/anthropic/omniagents',
            defaultBranch: 'main',
          },
        ],
      },
    }) as { additional_instructions: string };
    expect(vars.additional_instructions).toContain('## Workspace Layout');
    expect(vars.additional_instructions).toContain('3 sources co-mounted');
    expect(vars.additional_instructions).toContain('`/workspace/launcher/`');
    expect(vars.additional_instructions).toContain(
      '`/workspace/omniagents/` — https://github.com/anthropic/omniagents@main (git-remote)'
    );
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
