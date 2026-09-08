import { beforeEach, expect, it } from 'vitest';

import { applyChatCommand, type ChatCommand } from './chat-commands';
import type { CodeTab, StoreData } from './types';

let state: StoreData;
const tab = (id: string): CodeTab => ({ id, sessionId: `session-${id}`, projectId: null, createdAt: 1 });
function dispatch(command: ChatCommand) {
  const { patch, result } = applyChatCommand(state, command);
  state = { ...state, ...patch };
  return result;
}
beforeEach(() => {
  state = {
    codeTabs: [],
    chatConversations: [],
    activeCodeTabId: null,
    projects: [],
    defaultProfileName: 'host',
  } as unknown as StoreData;
});
it('applies two window creations to current state and commits selection with each tab', () => {
  const a = dispatch({ method: 'addTab', args: [] }) as CodeTab;
  const b = dispatch({ method: 'addTab', args: [] }) as CodeTab;
  expect(state.codeTabs.map((t) => t.id)).toEqual([a.id, b.id]);
  expect(state.activeCodeTabId).toBe(b.id);
});

it('commits removal and its retry job together and retries a lost command without duplicating the job', () => {
  state.codeTabs = [tab('A'), tab('B')];
  const first = dispatch({ method: 'removeTab', args: ['A'] });
  expect(state.codeTabs.map((t) => t.id)).toEqual(['B']);
  expect(state.chatCleanupJobs).toEqual([tab('A')]);
  const restarted = JSON.parse(JSON.stringify(state));
  state = restarted;
  expect(dispatch({ method: 'removeTab', args: ['A'] })).toEqual(first);
  expect(state.chatCleanupJobs).toEqual([tab('A')]);
});

it('rejects assigning a workspace that is pending destruction to a live tile', () => {
  state.codeTabs = [{ ...tab('A'), snapshotRef: 'retiring-workspace' }, tab('B')];
  dispatch({ method: 'removeTab', args: ['A'] });
  expect(() => dispatch({ method: 'setTabSnapshotRef', args: ['B', 'retiring-workspace'] })).toThrow('being removed');
  expect(state.codeTabs[0]?.snapshotRef).toBeUndefined();
});
it('ignores closed IDs in a stale reorder and retains current fields and new tabs', () => {
  state.codeTabs = [{ ...tab('B'), profileName: 'new-profile' }, tab('C')];
  dispatch({ method: 'reorderTabs', args: [['B', 'A', 'B']] });
  expect(state.codeTabs).toEqual([tab('C'), { ...tab('B'), profileName: 'new-profile' }]);
});
it('merges history entries and patches without replacing other sessions', () => {
  dispatch({ method: 'recordConversation', args: ['A', { title: 'A title' }] });
  dispatch({ method: 'recordConversation', args: ['B', { title: 'B title' }] });
  dispatch({ method: 'recordConversation', args: ['A', { projectId: 'project' }] });
  expect(state.chatConversations).toHaveLength(2);
  expect(state.chatConversations.find((c) => c.sessionId === 'A')).toMatchObject({
    title: 'A title',
    projectId: 'project',
  });
});
it('stale archive data does not roll back a newer title', () => {
  dispatch({ method: 'recordConversation', args: ['A', { title: 'new title' }] });
  dispatch({ method: 'archiveConversation', args: [{ sessionId: 'A', title: 'old title', lastActiveAt: 1 }] });
  expect(state.chatConversations[0]).toMatchObject({ title: 'new title', archivedAt: expect.any(Number) });
});
it('reopens from current metadata rather than a stale window history entry', () => {
  const stale = { sessionId: 'A', title: 'old', projectId: 'old-project', profileName: 'old-profile', lastActiveAt: 1 };
  dispatch({
    method: 'recordConversation',
    args: ['A', { title: 'new', projectId: 'new-project', profileName: 'host' }],
  });
  const reopened = dispatch({ method: 'addTabForConversation', args: [stale] }) as CodeTab;
  expect(reopened).toMatchObject({ projectId: 'new-project', profileName: 'host' });
  expect(state.chatConversations[0]?.title).toBe('new');
});
it('late title updates do not unarchive or recreate a removed tile', () => {
  state.codeTabs = [tab('A')];
  dispatch({ method: 'archiveTab', args: ['A'] });
  dispatch({ method: 'recordConversation', args: ['session-A', { title: 'late title' }] });
  expect(state.codeTabs).toEqual([]);
  expect(state.chatConversations[0]).toMatchObject({ title: 'late title', archivedAt: expect.any(Number) });
});
it('archives history and removes the tab in one reducer result', () => {
  state.codeTabs = [tab('A'), tab('B')];
  state.activeCodeTabId = 'A';
  const before = state;
  const { patch, result } = applyChatCommand(state, { method: 'archiveTab', args: ['A'] });
  expect(result).toEqual(tab('A'));
  expect(patch.codeTabs).toEqual([tab('B')]);
  expect(patch.activeCodeTabId).toBe('B');
  expect(patch.chatConversations?.[0]).toMatchObject({ sessionId: 'session-A', archivedAt: expect.any(Number) });
  expect(before.codeTabs).toHaveLength(2);
});
it('does not activate a removed tab or recreate it through a late property patch', () => {
  state.codeTabs = [tab('B')];
  state.activeCodeTabId = 'B';
  dispatch({ method: 'setActiveTab', args: ['A'] });
  dispatch({ method: 'setTabProfile', args: ['A', 'host'] });
  expect(state.activeCodeTabId).toBe('B');
  expect(state.codeTabs).toEqual([tab('B')]);
});
it('deduplicates concurrent conversation reopen and fresh-chat commands', () => {
  dispatch({ method: 'openFreshChat', args: [] });
  dispatch({ method: 'openFreshChat', args: [] });
  expect(state.codeTabs).toHaveLength(1);
  const conversation = { sessionId: 'existing', title: 'existing', lastActiveAt: 1 };
  dispatch({ method: 'addTabForConversation', args: [conversation] });
  dispatch({ method: 'addTabForConversation', args: [conversation] });
  expect(state.codeTabs.filter((t) => t.sessionId === 'existing')).toHaveLength(1);
});
it('routine tab creation checks current session identity at commit time', () => {
  const created = dispatch({
    method: 'ensureRoutineTab',
    args: [{ ...tab('A'), routineName: 'old' }, false],
  }) as CodeTab;
  dispatch({ method: 'ensureRoutineTab', args: [{ ...tab('B'), sessionId: 'session-A', routineName: 'new' }, true] });
  expect(state.codeTabs).toHaveLength(1);
  expect(state.codeTabs[0]).toMatchObject({ id: created.id, routineName: 'new' });
  expect(state.activeCodeTabId).toBe(created.id);
});

it('does not resurrect a retired routine tab identity from a stale window', () => {
  const old = { ...tab('old'), snapshotRef: 'retired-workspace' };
  state.codeTabs = [old];
  dispatch({ method: 'removeTab', args: [old.id] });
  const reopened = dispatch({ method: 'ensureRoutineTab', args: [old, true] }) as CodeTab;
  expect(reopened.id).not.toBe(old.id);
  expect(reopened.snapshotRef).not.toBe(old.snapshotRef);
  expect(reopened.sessionId).toBe(old.sessionId);
});

it('normalizes cleared session identity consistently across JSON and Electron transports', () => {
  state.codeTabs = [{ ...tab('A'), sessionId: undefined, snapshotRef: 'unchanged' }];
  const command: ChatCommand = { method: 'setTabSessionId', args: ['A', undefined] };
  dispatch(JSON.parse(JSON.stringify(command)) as ChatCommand);
  expect(state.codeTabs[0]).toMatchObject({ sessionId: undefined, snapshotRef: 'unchanged' });
});
