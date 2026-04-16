/**
 * Contract tests for page IPC handlers — verifies all 13 channels are
 * registered and delegate to the correct PageManager methods.
 *
 * `page:prepare-notebook` and `page:set-notebook-glass` are the only
 * non-trivial handlers — they chain async calls to writeGlassCss,
 * ensureNotebookCssReference, and writeMarimoAiConfig. These are mocked
 * here since the actual logic is tested in marimo-glass.test.ts and
 * marimo-config.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { StubIpc } from '@/test-helpers/stub-ipc';

// Mock the extension modules so the handlers can be invoked without fs
vi.mock('@/main/extensions/marimo-glass', () => ({
  writeGlassCss: vi.fn(async () => {}),
  ensureNotebookCssReference: vi.fn(async () => {}),
}));
vi.mock('@/main/extensions/marimo-config', () => ({
  writeMarimoAiConfig: vi.fn(async () => {}),
}));

// Import after mocks
import { registerPageHandlers } from '@/main/page-handlers';

const EXPECTED_CHANNELS = [
  'page:get-items',
  'page:get-all',
  'page:add-item',
  'page:update-item',
  'page:remove-item',
  'page:read-content',
  'page:write-content',
  'page:reorder',
  'page:watch',
  'page:unwatch',
  'page:get-notebook-paths',
  'page:prepare-notebook',
  'page:set-notebook-glass',
];

const makeManager = () => ({
  getByProject: vi.fn(() => []),
  getAll: vi.fn(() => []),
  add: vi.fn(() => ({ id: 'pg-1' })),
  update: vi.fn(),
  remove: vi.fn(),
  readContent: vi.fn(() => ''),
  writeContent: vi.fn(),
  reorder: vi.fn(),
  watch: vi.fn(() => ({ content: '' })),
  unwatch: vi.fn(),
  getNotebookFilePath: vi.fn(() => null),
  getById: vi.fn(() => null),
});

const makeGetProjectDir = () => vi.fn((_projectId: string) => '/tmp/project');

describe('registerPageHandlers', () => {
  it('registers all expected channels', () => {
    const ipc = new StubIpc();
    const channels = registerPageHandlers(ipc, makeManager() as never, makeGetProjectDir());
    expect(channels).toEqual(EXPECTED_CHANNELS);
    for (const ch of EXPECTED_CHANNELS) {
      expect(ipc.handlers.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  it('page:get-items delegates with projectId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    ipc.invoke('page:get-items', 'proj-1');
    expect(mgr.getByProject).toHaveBeenCalledWith('proj-1');
  });

  it('page:get-all delegates with no args', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    ipc.invoke('page:get-all');
    expect(mgr.getAll).toHaveBeenCalledOnce();
  });

  it('page:add-item delegates with item and template', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    const item = { projectId: 'p1', parentId: null, title: 'Test', sortOrder: 0 };
    ipc.invoke('page:add-item', item, 'inbox-item');
    expect(mgr.add).toHaveBeenCalledWith(item, 'inbox-item');
  });

  it('page:write-content delegates with pageId and content', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    ipc.invoke('page:write-content', 'pg-1', '# Hello');
    expect(mgr.writeContent).toHaveBeenCalledWith('pg-1', '# Hello');
  });

  it('page:reorder delegates with pageId, newParentId, newSortOrder', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    ipc.invoke('page:reorder', 'pg-1', 'parent-1', 3);
    expect(mgr.reorder).toHaveBeenCalledWith('pg-1', 'parent-1', 3);
  });

  it('page:get-notebook-paths returns null when notebook file path is null', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerPageHandlers(ipc, mgr as never, makeGetProjectDir());
    const result = ipc.invoke('page:get-notebook-paths', 'pg-1');
    expect(result).toBeNull();
  });

  it('page:get-notebook-paths returns filePath and projectDir when all resolves', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    mgr.getNotebookFilePath.mockReturnValue('/tmp/project/pages/nb.py' as never);
    mgr.getById.mockReturnValue({ id: 'pg-1', projectId: 'proj-1' } as never);
    const getDir = vi.fn(() => '/tmp/project');
    registerPageHandlers(ipc, mgr as never, getDir);
    const result = ipc.invoke('page:get-notebook-paths', 'pg-1');
    expect(result).toEqual({ filePath: '/tmp/project/pages/nb.py', projectDir: '/tmp/project' });
  });
});
