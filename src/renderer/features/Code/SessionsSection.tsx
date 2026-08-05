import { useStore } from '@nanostores/react';
import { Archive, ArchiveRestore, Ellipsis, FolderArchive, LoaderCircle } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { NavSection } from '@/renderer/common/NavSection';
import { SidebarRow, SidebarRowActions } from '@/renderer/common/SidebarRow';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/renderer/ds/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { $columnActivity, activityStatusText } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ChatConversation, CodeTab, ProjectId } from '@/shared/types';

import { APP_LAUNCHER_ID, codeApi } from './state';
const PAGE_SIZE = 5;
const PROJECT_PAGE_SIZE = 15;

/**
 * Session rows have two lifecycle states: open columns and retained history.
 * Runtime indicators are reserved for work in progress and user attention;
 * idle/history rows stay visually quiet.
 */
export type SessionEntry =
  | { kind: 'open'; key: string; tab: CodeTab; ts: number }
  | { kind: 'history'; key: string; conversation: ChatConversation; ts: number };

export const SessionRow = memo(function SessionRow({
  entry,
  label,
  selected,
  onActivate,
  onArchive,
  nested = false,
}: {
  entry: SessionEntry;
  label: string;
  selected: boolean;
  onActivate: (entry: SessionEntry) => void;
  onArchive: (entry: SessionEntry) => void;
  nested?: boolean;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const tabId = entry.kind === 'open' ? entry.tab.id : null;
  const activity = useStore($columnActivity, { keys: [tabId ?? ''] })[tabId ?? ''];
  const liveText = tabId ? activityStatusText(activity) : null;
  const working = entry.kind === 'open' && activity?.thinking === true;
  const attention = entry.kind === 'open' && activity?.pendingApproval === true;

  const handleClick = useCallback(() => onActivate(entry), [onActivate, entry]);
  const handleMenuOpenChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const handleArchive = useCallback(() => onArchive(entry), [onArchive, entry]);

  return (
    <SidebarRow>
      <SidebarMenuButton
        type="button"
        isActive={selected}
        className={nested ? 'pl-8' : undefined}
        onClick={handleClick}
      >
        <span className={cn('block min-w-0 flex-1 truncate', attention && 'font-semibold')} title={label}>
          {label}
        </span>
      </SidebarMenuButton>
      {attention || working ? (
        <SidebarMenuBadge className="px-0" title={attention ? 'Waiting for your approval' : (liveText ?? 'Working…')}>
          {attention ? (
            <span className="size-2 rounded-full bg-primary" />
          ) : working ? (
            <LoaderCircle className="sidebar-status-spinner size-3 animate-spin text-warning" />
          ) : null}
        </SidebarMenuBadge>
      ) : null}
      <SidebarRowActions open={menuOpen}>
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction aria-label={`${label} actions`}>
                  <Ellipsis />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Session actions
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={handleArchive}>
              <Archive />
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarRowActions>
    </SidebarRow>
  );
});
SessionRow.displayName = 'SessionRow';

export const ProjectSessionRows = memo(function ProjectSessionRows({
  projectId,
  sessionTitles,
  onNavigate,
}: {
  projectId: ProjectId;
  sessionTitles: ReadonlyMap<string, string>;
  onNavigate?: () => void;
}) {
  const store = useStore(persistedStoreApi.$atom);
  const projectEntries = useMemo((): SessionEntry[] => {
    const conversations = (store.chatConversations ?? []).filter(
      (conversation) => conversation.projectId === projectId && !conversation.archivedAt
    );
    const conversationsBySession = new Map(conversations.map((conversation) => [conversation.sessionId, conversation]));
    const tabs = (store.codeTabs ?? []).filter((tab) => tab.projectId === projectId);
    const openSessionIds = new Set(tabs.map((tab) => tab.sessionId).filter(Boolean));
    const open: SessionEntry[] = tabs.map((tab) => ({
      kind: 'open',
      key: tab.id,
      tab,
      ts: (tab.sessionId ? conversationsBySession.get(tab.sessionId)?.lastActiveAt : undefined) ?? tab.createdAt,
    }));
    const history: SessionEntry[] = conversations
      .filter((conversation) => !openSessionIds.has(conversation.sessionId))
      .map((conversation) => ({
        kind: 'history',
        key: `project:${projectId}:${conversation.sessionId}`,
        conversation,
        ts: conversation.lastActiveAt,
      }));
    return [...open, ...history].sort((a, b) => b.ts - a.ts);
  }, [projectId, store.chatConversations, store.codeTabs]);
  const [historyVisible, setHistoryVisible] = useState(PROJECT_PAGE_SIZE);
  const visibleEntries = useMemo(() => {
    let historyBudget = historyVisible;
    return projectEntries.filter((entry) => {
      if (entry.kind === 'open') {
        return true;
      }
      if (historyBudget > 0) {
        historyBudget -= 1;
        return true;
      }
      return false;
    });
  }, [historyVisible, projectEntries]);
  const historyCount = projectEntries.filter((entry) => entry.kind === 'history').length;
  const historyHidden = Math.max(0, historyCount - historyVisible);
  const activeTabId = store.activeCodeTabId ?? null;
  const selectedKey = store.layoutMode === 'chat' && store.codeLayoutMode === 'focus' ? activeTabId : null;

  const handleActivate = useCallback(
    (entry: SessionEntry) => {
      if (entry.kind === 'open') {
        codeApi.setActiveTab(entry.tab.id);
      } else {
        void codeApi.addTabForConversation(entry.conversation);
      }
      codeApi.setLayoutMode('focus');
      if (persistedStoreApi.$atom.get().layoutMode !== 'chat') {
        persistedStoreApi.setKey('layoutMode', 'chat');
      }
      onNavigate?.();
    },
    [onNavigate]
  );
  const handleShowMore = useCallback(() => setHistoryVisible((count) => count + PROJECT_PAGE_SIZE), []);
  const handleArchive = useCallback(
    (entry: SessionEntry) => {
      if (entry.kind === 'history') {
        void codeApi.archiveConversation(entry.conversation);
        return;
      }
      const title = entry.tab.sessionId ? sessionTitles.get(entry.tab.sessionId) : undefined;
      void codeApi.archiveTab(entry.tab.id, title);
    },
    [sessionTitles]
  );

  if (projectEntries.length === 0) {
    return null;
  }

  return (
    <>
      <SidebarMenuSub aria-label="Project sessions" className="mx-0 translate-x-0 gap-1 border-l-0 px-0 pt-1! pb-0!">
        {visibleEntries.map((entry) => {
          const label =
            entry.kind === 'history'
              ? entry.conversation.title
              : ((entry.tab.sessionId ? sessionTitles.get(entry.tab.sessionId) : undefined) ??
                entry.tab.ticketTitle ??
                entry.tab.routineName ??
                'New chat');
          return (
            <SessionRow
              key={entry.key}
              entry={entry}
              label={label}
              selected={selectedKey === entry.key}
              onActivate={handleActivate}
              onArchive={handleArchive}
              nested
            />
          );
        })}
        {historyHidden > 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              className="h-7 pl-8 text-xs text-muted-foreground"
              onClick={handleShowMore}
            >
              <span>Show more ({historyHidden})</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenuSub>
    </>
  );
});
ProjectSessionRows.displayName = 'ProjectSessionRows';

function ArchivedSessionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const store = useStore(persistedStoreApi.$atom);
  const archived = useMemo(
    () =>
      (store.chatConversations ?? [])
        .filter((conversation) => conversation.archivedAt)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [store.chatConversations]
  );
  const projectLabels = useMemo(
    () => new Map(store.projects.map((project) => [project.id, project.label])),
    [store.projects]
  );
  const handleRestore = useCallback((sessionId: string) => {
    void codeApi.restoreConversation(sessionId);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archived sessions</DialogTitle>
          <DialogDescription>Restore sessions to their project or Recents.</DialogDescription>
        </DialogHeader>
        {archived.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No archived sessions</p>
        ) : (
          <ScrollArea className="sidebar-archive-list pr-3">
            <ItemGroup>
              {archived.map((conversation) => (
                <Item key={conversation.sessionId} size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full truncate">{conversation.title}</ItemTitle>
                    <ItemDescription>
                      {conversation.projectId
                        ? (projectLabels.get(conversation.projectId) ?? 'Deleted project')
                        : 'Recents'}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRestore(conversation.sessionId)}
                    >
                      <ArchiveRestore />
                      Restore
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RecentsSection({
  recent,
  sessionTitles,
  onNavigate,
}: {
  recent: ChatConversation[];
  sessionTitles: ReadonlyMap<string, string>;
  onNavigate?: () => void;
}): React.JSX.Element {
  const store = useStore(persistedStoreApi.$atom);
  const columnActivity = useStore($columnActivity);
  const tabs = useMemo(() => store.codeTabs ?? [], [store.codeTabs]);
  const unassociatedRecent = useMemo(
    () => recent.filter((conversation) => !conversation.projectId && !conversation.archivedAt),
    [recent]
  );
  const [archiveOpen, setArchiveOpen] = useState(false);

  const customApps = useMemo(() => store.customApps ?? [], [store.customApps]);

  // Same resolution the deck uses for column titles (identity must match
  // between the sidebar row and the column it opens).
  const resolveLabel = useCallback(
    (entry: SessionEntry): string => {
      if (entry.kind === 'history') {
        return entry.conversation.title;
      }
      const tab = entry.tab;
      if (tab.customAppId === APP_LAUNCHER_ID) {
        return 'Apps';
      }
      if (tab.customAppId === 'browser') {
        return 'Browser';
      }
      if (tab.customAppId) {
        return customApps.find((a) => a.id === tab.customAppId)?.label ?? 'App';
      }
      if (tab.routineName) {
        return tab.routineName;
      }
      return (tab.sessionId ? sessionTitles.get(tab.sessionId) : undefined) ?? 'New chat';
    },
    [customApps, sessionTitles]
  );

  // One list, recency-sorted; open columns and retained history interleave.
  // Empty chats stay out: a chat column earns its row when its session
  // becomes a conversation (first message titles it). The pristine landing
  // column in particular never shows. Bound columns (apps and routines)
  // always have identities and always list. Project-bound tabs are rendered
  // beneath their project instead of being duplicated here.
  const entries = useMemo((): SessionEntry[] => {
    const isEmptyChat = (tab: CodeTab): boolean =>
      !tab.projectId &&
      !tab.customAppId &&
      !tab.ticketId &&
      !tab.routineId &&
      (!tab.sessionId || !sessionTitles.has(tab.sessionId));
    const open: SessionEntry[] = tabs
      .filter((tab) => !tab.projectId && !isEmptyChat(tab))
      .map((tab) => ({ kind: 'open', key: tab.id, tab, ts: tab.createdAt }));
    const history: SessionEntry[] = unassociatedRecent.map((conversation) => ({
      kind: 'history',
      key: `recent:${conversation.sessionId}`,
      conversation,
      ts: conversation.lastActiveAt,
    }));
    return [...open, ...history].sort((a, b) => b.ts - a.ts);
  }, [tabs, unassociatedRecent, sessionTitles]);

  // Paging budgets history rows only — open rows are never hidden behind
  // the fold, wherever recency sorts them.
  const [historyVisible, setHistoryVisible] = useState(PAGE_SIZE);
  const handleShowMore = useCallback(() => setHistoryVisible((count) => count + PAGE_SIZE), []);
  const visibleEntries = useMemo(() => {
    let historyBudget = historyVisible;
    return entries.filter((entry) => {
      if (entry.kind === 'open') {
        return true;
      }
      if (historyBudget > 0) {
        historyBudget -= 1;
        return true;
      }
      return false;
    });
  }, [entries, historyVisible]);
  const historyHidden = Math.max(0, unassociatedRecent.length - historyVisible);

  const activeTabId = store.activeCodeTabId ?? tabs[0]?.id ?? null;
  // Selection mirrors what fills the plane (see module doc).
  const selectedKey = store.layoutMode === 'chat' && store.codeLayoutMode === 'focus' ? activeTabId : null;

  const raiseDeck = useCallback(() => {
    if (persistedStoreApi.$atom.get().layoutMode !== 'chat') {
      persistedStoreApi.setKey('layoutMode', 'chat');
    }
  }, []);

  // "Take me to this conversation" — whether that means activating a column
  // or materializing one from retained history is the app's business.
  const handleActivate = useCallback(
    (entry: SessionEntry) => {
      if (entry.kind === 'open') {
        codeApi.setActiveTab(entry.tab.id);
      } else {
        void codeApi.addTabForConversation(entry.conversation);
      }
      codeApi.setLayoutMode('focus');
      raiseDeck();
      onNavigate?.();
    },
    [raiseDeck, onNavigate]
  );
  const handleArchive = useCallback(
    (entry: SessionEntry) => {
      if (entry.kind === 'history') {
        void codeApi.archiveConversation(entry.conversation);
        return;
      }
      const title = entry.tab.sessionId ? sessionTitles.get(entry.tab.sessionId) : undefined;
      void codeApi.archiveTab(entry.tab.id, title);
    },
    [sessionTitles]
  );

  // Aggregate attention for the collapsed header: approvals waiting on you.
  const attentionCount = entries.filter(
    (entry) => entry.kind === 'open' && columnActivity[entry.tab.id]?.pendingApproval === true
  ).length;

  return (
    <>
      <NavSection
        id="recents"
        label="Recents"
        collapsedBadge={attentionCount}
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction aria-label="Archived sessions" onClick={() => setArchiveOpen(true)}>
                <FolderArchive />
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Archived sessions
            </TooltipContent>
          </Tooltip>
        }
      >
        {visibleEntries.length > 0 && (
          <SidebarMenu aria-label="Recents">
            {visibleEntries.map((entry) => (
              <SessionRow
                key={entry.key}
                entry={entry}
                label={resolveLabel(entry)}
                selected={selectedKey === entry.key}
                onActivate={handleActivate}
                onArchive={handleArchive}
              />
            ))}
            {historyHidden > 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton type="button" className="text-xs text-muted-foreground" onClick={handleShowMore}>
                  <span>Show more ({historyHidden})</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        )}
      </NavSection>
      <ArchivedSessionsDialog open={archiveOpen} onOpenChange={setArchiveOpen} />
    </>
  );
}
