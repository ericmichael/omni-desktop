/**
 * Contract tests for project IPC handlers — verifies all channels are
 * registered and delegate to the correct ProjectManager methods.
 */
import { describe, expect, it, vi } from 'vitest';

// Mock worktree-ops so `checkGitRepo` doesn't hit real git
vi.mock('@/main/worktree-ops', () => ({
  checkGitRepo: vi.fn(() => ({ isGitRepo: false })),
}));

import { registerProjectHandlers } from '@/main/project-handlers';
import { StubIpc } from '@/test-helpers/stub-ipc';

const EXPECTED_CHANNELS = [
  'project:add-project',
  'project:update-project',
  'project:remove-project',
  'project:get-dir',
  'project:check-git-repo',
  'project:add-ticket',
  'project:update-ticket',
  'project:remove-ticket',
  'project:get-tickets',
  'project:get-next-ticket',
  'project:move-ticket-to-column',
  'project:resolve-ticket',
  'project:assign-ticket',
  'project:get-pipeline',
  'project:list-artifacts',
  'project:read-artifact',
  'project:open-artifact-external',
  'project:get-files-changed',
  'project:get-code-tab-files-changed',
  'project:apply-code-tab-source-changes',
  'project:detect-code-tab-pull-request',
  'project:detect-code-tab-pull-requests',
  'project:detect-chat-pull-requests',
  'project:merge-ticket',
  'project:detect-pull-request',
  'project:read-context',
  'project:write-context',
  'project:list-project-files',
  'project:get-context-preview',
  'project:open-project-file',
];

const makeManager = () => ({
  addProject: vi.fn(() => ({ id: 'proj-1' })),
  updateProject: vi.fn(),
  removeProject: vi.fn(),
  getProjectDir: vi.fn(() => '/tmp/project'),
  addTicket: vi.fn(() => ({ id: 't1' })),
  updateTicket: vi.fn(),
  removeTicket: vi.fn(),
  getTicketsByProject: vi.fn(() => []),
  getNextTicket: vi.fn(() => null),
  moveTicketToColumn: vi.fn(),
  resolveTicket: vi.fn(),
  getPipeline: vi.fn(() => ({ columns: [] })),
  listArtifacts: vi.fn(() => []),
  readArtifact: vi.fn(() => ({ relativePath: '', mimeType: '', textContent: null, size: 0 })),
  openArtifactExternal: vi.fn(),
  getFilesChanged: vi.fn(() => ({ totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] })),
  getCodeTabFilesChanged: vi.fn(() => ({
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    hasChanges: false,
    files: [],
  })),
  applyCodeTabSourceChanges: vi.fn(async () => ({ ok: true, mergeCommitSha: 'apply' })),
  detectCodeTabPullRequest: vi.fn(async () => null),
  detectCodeTabPullRequests: vi.fn(async () => []),
  detectChatPullRequests: vi.fn(async () => []),
  readContext: vi.fn(() => ''),
  writeContext: vi.fn(),
  listProjectFiles: vi.fn(() => []),
  getContextPreview: vi.fn(() => ''),
  openProjectFile: vi.fn(),
  mergePrTicket: vi.fn(async () => ({ ok: true, mergeCommitSha: 'deadbeef' })),
  detectPullRequest: vi.fn(async () => null),
});

describe('registerProjectHandlers', () => {
  it('registers all expected channels', () => {
    const ipc = new StubIpc();
    const channels = registerProjectHandlers(ipc, () => makeManager() as never);
    expect(channels).toEqual(EXPECTED_CHANNELS);
    for (const ch of EXPECTED_CHANNELS) {
      expect(ipc.handlers.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  it('project:add-project delegates with project data', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:add-project', { label: 'New' });
    expect(mgr.addProject).toHaveBeenCalledWith({ label: 'New' });
  });

  it('project:update-project delegates with id and patch', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:update-project', 'proj-1', { label: 'Renamed' });
    expect(mgr.updateProject).toHaveBeenCalledWith('proj-1', { label: 'Renamed' });
  });

  it('project:remove-project delegates with id', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:remove-project', 'proj-1');
    expect(mgr.removeProject).toHaveBeenCalledWith('proj-1');
  });

  it('project:add-ticket delegates with ticket data', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:add-ticket', { title: 'Bug fix', projectId: 'p1' });
    expect(mgr.addTicket).toHaveBeenCalledWith({ title: 'Bug fix', projectId: 'p1' });
  });

  it('project:get-tickets delegates with projectId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:get-tickets', 'proj-1');
    expect(mgr.getTicketsByProject).toHaveBeenCalledWith('proj-1');
  });

  it('project:move-ticket-to-column delegates with ticketId and columnId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:move-ticket-to-column', 't1', 'in_progress');
    expect(mgr.moveTicketToColumn).toHaveBeenCalledWith('t1', 'in_progress');
  });

  it('project:resolve-ticket delegates with ticketId and resolution', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:resolve-ticket', 't1', 'completed');
    expect(mgr.resolveTicket).toHaveBeenCalledWith('t1', 'completed');
  });

  it('project:get-pipeline delegates with projectId', async () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    await ipc.invoke('project:get-pipeline', 'proj-1');
    expect(mgr.getPipeline).toHaveBeenCalledWith('proj-1');
  });

  it('project:read-context delegates with projectId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:read-context', 'proj-1');
    expect(mgr.readContext).toHaveBeenCalledWith('proj-1');
  });

  it('project:write-context delegates with projectId and content', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:write-context', 'proj-1', '# Context');
    expect(mgr.writeContext).toHaveBeenCalledWith('proj-1', '# Context');
  });

  it('project:list-artifacts delegates with ticketId and optional dirPath', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:list-artifacts', 't1', 'sub/dir');
    expect(mgr.listArtifacts).toHaveBeenCalledWith('t1', 'sub/dir');
  });

  it('project:get-files-changed delegates with ticketId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:get-files-changed', 't1', 'src1');
    expect(mgr.getFilesChanged).toHaveBeenCalledWith('t1', 'src1');
  });

  it('project:get-code-tab-files-changed delegates with tabId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:get-code-tab-files-changed', 'tab1', 'src1');
    expect(mgr.getCodeTabFilesChanged).toHaveBeenCalledWith('tab1', 'src1');
  });

  it('project:apply-code-tab-source-changes delegates with tabId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:apply-code-tab-source-changes', 'tab1', 'src1');
    expect(mgr.applyCodeTabSourceChanges).toHaveBeenCalledWith('tab1', 'src1');
  });

  it('project:merge-ticket delegates with ticketId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:merge-ticket', 't1', 'src1');
    expect(mgr.mergePrTicket).toHaveBeenCalledWith('t1', 'src1');
  });

  it('project:detect-pull-request delegates with ticketId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:detect-pull-request', 't1', 'src1');
    expect(mgr.detectPullRequest).toHaveBeenCalledWith('t1', 'src1');
  });

  it('project:detect-code-tab-pull-request delegates with tabId + sourceId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:detect-code-tab-pull-request', 'tab1', 'src1');
    expect(mgr.detectCodeTabPullRequest).toHaveBeenCalledWith('tab1', 'src1');
  });

  it('project:detect-code-tab-pull-requests delegates with tabId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:detect-code-tab-pull-requests', 'tab1');
    expect(mgr.detectCodeTabPullRequests).toHaveBeenCalledWith('tab1');
  });

  it('project:detect-chat-pull-requests delegates with no args', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerProjectHandlers(ipc, () => mgr as never);
    ipc.invoke('project:detect-chat-pull-requests');
    expect(mgr.detectChatPullRequests).toHaveBeenCalledWith();
  });
});
