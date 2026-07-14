import {
  Button as FluentButton,
  makeStyles,
  mergeClasses,
  shorthands,
  Subtitle2,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowMaximize20Regular,
  ArrowMinimize20Regular,
  BranchFork20Regular,
  Chat20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Edit20Regular,
  MoreHorizontal20Filled,
  Play20Filled,
  ReOrderDotsVertical20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isDoneColumn } from '@/lib/pipeline-category';
import type { SelectTabData } from '@/renderer/ds';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  ConfirmDialog,
  IconButton,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  Switch,
  Tab,
  TabList,
} from '@/renderer/ds';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, TicketId, TicketPhase, TicketResolution } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { ProjectPageHeader } from './ProjectPageHeader';
import { $pipeline, $tickets, ticketApi } from './state';
import { RESOLUTION_LABELS } from './ticket-constants';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketOverviewTab } from './TicketOverviewTab';
import { TicketPRTab } from './TicketPRTab';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  },
  /* ── Row 1: Title ── */
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  dragHandle: {
    cursor: 'grab',
    ':active': { cursor: 'grabbing' },
  },
  titleBtn: {
    minWidth: 0,
    flex: '1 1 0',
    justifyContent: 'flex-start',
    ':hover > .editIcon': { opacity: 1 },
  },
  /* Page-context editable title (matches ProjectPageHeader's Title3 scale). */
  pageTitleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flex: '0 1 auto',
    minWidth: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover > .editIcon': { opacity: 1 },
  },
  pageTitleText: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pageTitleInput: {
    flex: '1 1 0',
    minWidth: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    ':focus': { outline: 'none' },
  },
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  editIcon: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  titleInput: {
    flex: '1 1 0',
    minWidth: 0,
  },
  actionGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  /* ── Mobile action bar (replaces the title bar under the TopAppBar) ── */
  mobileActionBar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  mobileActionSpacer: {
    flex: '1 1 0',
  },
  /* ── Row 2: Tabs + overflow ── */
  tabRow: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  tabList: {
    flex: '1 1 0',
  },
  /* ── Branch edit bar (conditional) ── */
  branchEditBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    flexShrink: 0,
  },
  branchGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  /* ── Content ── */
  overviewScroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXL,
  },
  tabPane: {
    flex: '1 1 0',
    minHeight: 0,
  },
  notFound: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
});

/* Discussion lives inline in the Overview (GitHub issue shape), not a tab. */
type TicketTab = 'Overview' | 'PR' | 'Artifacts';
const TABS: TicketTab[] = ['Overview', 'PR', 'Artifacts'];

type DragHandleProps = {
  attributes: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  listeners: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type TicketDetailProps = {
  ticketId: TicketId;
  compact?: boolean;
  hideTitleBar?: boolean;
  onClose?: () => void;
  closeBehavior?: 'close' | 'back';
  dragHandleProps?: DragHandleProps;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export const TicketDetail = memo(
  ({
    ticketId,
    compact,
    hideTitleBar = false,
    onClose,
    closeBehavior = 'close',
    dragHandleProps,
    isExpanded,
    onToggleExpand,
  }: TicketDetailProps) => {
    const styles = useStyles();
    const tickets = useStore($tickets);
    const pipeline = useStore($pipeline);
    const store = useStore(persistedStoreApi.$atom);
    const ticket = tickets[ticketId];
    const project = useMemo(
      () => store.projects.find((p) => p.id === ticket?.projectId) ?? null,
      [store.projects, ticket?.projectId]
    );
    const [activeTab, setCurrentTab] = useState<TicketTab>('Overview');
    const [editingTitle, setEditingTitle] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
    const [editingBranch, setEditingBranch] = useState(false);
    const [editBranch, setEditBranch] = useState('');
    const [editUseWorktree, setEditUseWorktree] = useState(true);

    useEffect(() => {
      const s = firstSource(project);
      if (s?.kind !== 'local') {
        setGitInfo(null);
        return;
      }
      ticketApi.checkGitRepo(s.workspaceDir).then((info) => {
        setGitInfo(info);
      });
    }, [project]);

    const handleStartEditTitle = useCallback(() => {
      if (ticket) {
        setEditTitle(ticket.title);
        setEditingTitle(true);
      }
    }, [ticket]);

    const handleEditTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setEditTitle(e.target.value);
    }, []);

    const handleSaveTitle = useCallback(() => {
      const trimmed = editTitle.trim();
      if (trimmed && ticket && trimmed !== ticket.title) {
        void ticketApi.updateTicket(ticketId, { title: trimmed });
      }
      setEditingTitle(false);
    }, [editTitle, ticket, ticketId]);

    const handleStartEditBranch = useCallback(() => {
      if (!ticket) {
        return;
      }
      setEditBranch(ticket.branch ?? '');
      setEditUseWorktree(ticket.useWorktree ?? false);
      setEditingBranch(true);
    }, [ticket]);

    const handleCancelEditBranch = useCallback(() => {
      setEditingBranch(false);
    }, []);

    const handleSaveBranch = useCallback(() => {
      if (!ticket) {
        return;
      }
      // Direct mode: clear the branch too — a ticket running against the
      // project's working tree doesn't own one, and leaving a stale value
      // would make the UI claim a branch the supervisor isn't using.
      void ticketApi.updateTicket(ticketId, {
        useWorktree: editUseWorktree,
        branch: editUseWorktree ? editBranch || undefined : undefined,
      });
      setEditingBranch(false);
    }, [editBranch, editUseWorktree, ticket, ticketId]);

    const handleTitleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          handleSaveTitle();
        } else if (e.key === 'Escape') {
          setEditingTitle(false);
        }
      },
      [handleSaveTitle]
    );

    const handleGoToBoard = useCallback(() => {
      if (ticket?.projectId) {
        ticketApi.goToProject(ticket.projectId, 'board');
      }
    }, [ticket?.projectId]);

    const handleOpenChat = useCallback(() => {
      void openTicketInCode(ticketId);
    }, [ticketId]);

    const handleStartAutopilot = useCallback(() => {
      ticketApi.requestStartSupervisor(ticketId);
    }, [ticketId]);

    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const handleRequestDelete = useCallback(() => setDeleteConfirmOpen(true), []);
    const handleCloseDelete = useCallback(() => setDeleteConfirmOpen(false), []);
    const handleDelete = useCallback(() => {
      void ticketApi.removeTicket(ticketId);
    }, [ticketId]);

    const isTerminalColumn = useMemo(() => {
      if (!pipeline || !ticket) {
        return false;
      }
      return isDoneColumn(pipeline, ticket.columnId);
    }, [pipeline, ticket]);

    const handleResolve = useCallback(
      (resolution: TicketResolution) => {
        ticketApi.resolveTicket(ticketId, resolution);
      },
      [ticketId]
    );

    const handleArchive = useCallback(() => {
      void ticketApi.updateTicket(ticketId, { archivedAt: Date.now() });
    }, [ticketId]);

    const handleUnarchive = useCallback(() => {
      void ticketApi.updateTicket(ticketId, { archivedAt: undefined });
    }, [ticketId]);

    const handleTabSelect = useCallback((_e: unknown, data: SelectTabData) => {
      setCurrentTab(data.value as TicketTab);
    }, []);

    const handleBranchChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
      setEditBranch(event.target.value);
    }, []);

    // -------------------------------------------------------------------------
    // Flush-on-unmount.
    //
    // The parent keys this component on `ticketId`, so navigating to a
    // different ticket fully remounts us — edit buffers (`editTitle`,
    // `editBranch`) can never cross ticket boundaries. But a mid-edit user
    // who navigates away without pressing Enter or blurring the input would
    // otherwise lose that edit. On unmount we call the latest save closures,
    // which close over the current buffers AND the current `ticketId`, so
    // any pending title/branch change lands on the right ticket.
    //
    // The save handlers are already idempotent: `handleSaveTitle` no-ops when
    // trimmed/unchanged, and `handleSaveBranch` only fires when we're
    // actively in edit mode (guarded below). Safe to call unconditionally.
    // -------------------------------------------------------------------------
    const flushRef = useRef<() => void>(() => {});
    flushRef.current = () => {
      if (editingTitle) {
        handleSaveTitle();
      }
      if (editingBranch) {
        handleSaveBranch();
      }
    };
    useEffect(() => {
      return () => {
        flushRef.current();
      };
    }, []);

    if (!ticket) {
      return (
        <div className={styles.notFound}>
          <Body1>Task not found</Body1>
        </div>
      );
    }

    const phase = ticket.phase;

    return (
      <div className={styles.root}>
        {!hideTitleBar &&
          (onClose && closeBehavior === 'back' && ticket.projectId ? (
            /* Work-tab page context: the standard sub-page header — small
               ancestors-only breadcrumb (Project › Tasks) above the real,
               click-to-rename page title, with the ticket controls on the
               title row. */
            <ProjectPageHeader
              projectId={ticket.projectId}
              middle={[{ label: 'Tasks', onClick: handleGoToBoard }]}
              title={
                editingTitle ? (
                  <input
                    aria-label="Task title"
                    className={styles.pageTitleInput}
                    value={editTitle}
                    onChange={handleEditTitleChange}
                    onBlur={handleSaveTitle}
                    onKeyDown={handleTitleKeyDown}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.pageTitleBtn}
                    onClick={handleStartEditTitle}
                    title="Rename task"
                  >
                    <span className={styles.pageTitleText}>{ticket.title}</span>
                    <Edit20Regular className={mergeClasses(styles.editIcon, 'editIcon')} />
                  </button>
                )
              }
              actions={<PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />}
            />
          ) : (
            /* Panel context (Code deck side panel): compact single row. */
            <div className={styles.titleBar}>
              {dragHandleProps && (
                <FluentButton
                  appearance="subtle"
                  shape="circular"
                  size="small"
                  icon={<ReOrderDotsVertical20Regular />}
                  aria-label="Reorder"
                  className={styles.dragHandle}
                  {...dragHandleProps.attributes}
                  {...dragHandleProps.listeners}
                />
              )}

              {editingTitle ? (
                <Input
                  type="text"
                  value={editTitle}
                  onChange={handleEditTitleChange}
                  onBlur={handleSaveTitle}
                  onKeyDown={handleTitleKeyDown}
                  autoFocus
                  size="sm"
                  className={styles.titleInput}
                />
              ) : (
                <FluentButton
                  appearance="transparent"
                  size="small"
                  onClick={handleStartEditTitle}
                  className={styles.titleBtn}
                >
                  <Subtitle2 className={styles.titleText}>{ticket.title}</Subtitle2>
                  <Edit20Regular className={mergeClasses(styles.editIcon, 'editIcon')} />
                </FluentButton>
              )}

              <PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />

              {onToggleExpand && (
                <IconButton
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  icon={isExpanded ? <ArrowMinimize20Regular /> : <ArrowMaximize20Regular />}
                  size="sm"
                  onClick={onToggleExpand}
                />
              )}
              {onClose && closeBehavior === 'close' && (
                <IconButton aria-label="Close" icon={<Dismiss20Regular />} size="sm" onClick={onClose} />
              )}
            </div>
          ))}

        {/* Mobile: the TopAppBar owns back + title; this row carries the
            agent actions (fields live in the Overview's properties rail).
            Rename swaps the row for the title input. */}
        {hideTitleBar && (
          <div className={styles.mobileActionBar}>
            {editingTitle ? (
              <Input
                type="text"
                value={editTitle}
                onChange={handleEditTitleChange}
                onBlur={handleSaveTitle}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                size="sm"
                className={styles.titleInput}
              />
            ) : (
              <>
                <div className={styles.mobileActionSpacer} />
                <PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />
              </>
            )}
          </div>
        )}

        {/* ── Row 2: Tabs + overflow menu ── */}
        <div className={styles.tabRow}>
          <TabList size="small" selectedValue={activeTab} onTabSelect={handleTabSelect} className={styles.tabList}>
            {TABS.map((tab) => (
              <Tab key={tab} value={tab}>
                {tab}
              </Tab>
            ))}
          </TabList>

          {!compact && (
            <Menu positioning={{ position: 'below', align: 'end', fallbackPositions: ['above-end'] }}>
              <MenuTrigger>
                <IconButton aria-label="Task menu" icon={<MoreHorizontal20Filled />} size="sm" />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {hideTitleBar && (
                    <MenuItem icon={<Edit20Regular />} onClick={handleStartEditTitle}>
                      Rename task
                    </MenuItem>
                  )}
                  {gitInfo?.isGitRepo && (
                    <MenuItem icon={<BranchFork20Regular />} onClick={handleStartEditBranch}>
                      Edit branch
                    </MenuItem>
                  )}
                  {!ticket.resolution && !isTerminalColumn && (
                    <>
                      <MenuDivider />
                      {(['completed', 'wont_do', 'duplicate', 'cancelled'] as TicketResolution[]).map((res) => (
                        <ResolutionMenuItem key={res} resolution={res} onResolve={handleResolve} />
                      ))}
                    </>
                  )}
                  {ticket.resolution && (
                    <>
                      <MenuDivider />
                      {ticket.archivedAt ? (
                        <MenuItem onClick={handleUnarchive}>Unarchive task</MenuItem>
                      ) : (
                        <MenuItem onClick={handleArchive}>Archive task</MenuItem>
                      )}
                    </>
                  )}
                  <MenuDivider />
                  <MenuItem icon={<Delete20Regular />} onClick={handleRequestDelete}>
                    Delete task
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
        </div>

        {/* Branch edit (conditional) */}
        {editingBranch && gitInfo?.isGitRepo && (
          <div className={styles.branchEditBar}>
            <div className={styles.branchGroup}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightMedium }}>
                Isolated worktree
              </Caption1>
              <Switch
                checked={editUseWorktree}
                onCheckedChange={setEditUseWorktree}
                disabled={Boolean(ticket.worktreePath)}
              />
            </div>
            {editUseWorktree && (
              <div className={styles.branchGroup}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightMedium }}>
                  Branch
                </Caption1>
                <Select value={editBranch} onChange={handleBranchChange} size="sm">
                  <option value="">None</option>
                  {gitInfo.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
              {ticket.worktreePath
                ? 'Clean up the active worktree before switching modes.'
                : editUseWorktree
                  ? 'The agent works in its own branch + worktree, isolated from the main checkout.'
                  : 'The agent works directly in the project checkout. Only one direct-mode task can run at a time.'}
            </Caption1>
            <div className={styles.branchGroup}>
              <Button size="sm" onClick={handleSaveBranch}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEditBranch}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'Overview' && (
          <div className={styles.overviewScroll}>
            <TicketOverviewTab ticket={ticket} compact={compact} />
          </div>
        )}
        {activeTab === 'PR' && (
          <div className={styles.tabPane}>
            <TicketPRTab ticketId={ticketId} />
          </div>
        )}
        {activeTab === 'Artifacts' && (
          <div className={styles.tabPane}>
            <TicketArtifactsTab ticketId={ticketId} />
          </div>
        )}

        <ConfirmDialog
          open={deleteConfirmOpen}
          onClose={handleCloseDelete}
          onConfirm={handleDelete}
          title={
            !ticket.title || ticket.title === 'Untitled'
              ? 'Delete this untitled task?'
              : `Delete task "${ticket.title}"?`
          }
          description="This action cannot be undone."
          confirmLabel="Delete"
          destructive
        />
      </div>
    );
  }
);
TicketDetail.displayName = 'TicketDetail';

type ResolutionMenuItemProps = {
  resolution: TicketResolution;
  onResolve: (resolution: TicketResolution) => void;
};

const ResolutionMenuItem = memo(({ resolution, onResolve }: ResolutionMenuItemProps) => {
  const handleResolve = useCallback(() => onResolve(resolution), [onResolve, resolution]);

  return <MenuItem onClick={handleResolve}>{RESOLUTION_LABELS[resolution]}</MenuItem>;
});
ResolutionMenuItem.displayName = 'ResolutionMenuItem';

// --- Phase status (read-only badge + action buttons) ---

const PHASE_BADGE: Record<string, { label: string; color: 'green' | 'yellow' | 'blue' | 'red' }> = {
  running: { label: 'Working', color: 'green' },
  continuing: { label: 'Working', color: 'green' },
  provisioning: { label: 'Starting', color: 'blue' },
  connecting: { label: 'Connecting', color: 'blue' },
  session_creating: { label: 'Starting', color: 'blue' },
  awaiting_input: { label: 'Needs input', color: 'blue' },
  retrying: { label: 'Retrying', color: 'yellow' },
  error: { label: 'Error', color: 'red' },
  completed: { label: 'Done', color: 'green' },
};

const PhaseStatus = memo(
  ({ phase, onChat, onAutopilot }: { phase: TicketPhase | undefined; onChat: () => void; onAutopilot: () => void }) => {
    const styles = useStyles();

    const badge = phase ? PHASE_BADGE[phase] : undefined;
    if (phase === 'error') {
      return (
        <div className={styles.actionGroup}>
          <Badge color="red">Error</Badge>
          <Button size="sm" variant="ghost" leftIcon={<Chat20Regular />} onClick={onChat}>
            Chat
          </Button>
          <Button size="sm" leftIcon={<Play20Filled />} onClick={onAutopilot}>
            Retry
          </Button>
        </div>
      );
    }
    if (badge) {
      return (
        <div className={styles.actionGroup}>
          <Badge color={badge.color}>{badge.label}</Badge>
        </div>
      );
    }

    // Idle — show action buttons
    return (
      <div className={styles.actionGroup}>
        <Button size="sm" variant="ghost" leftIcon={<Chat20Regular />} onClick={onChat}>
          Chat
        </Button>
        <Button size="sm" leftIcon={<Play20Filled />} onClick={onAutopilot}>
          Start agent
        </Button>
      </div>
    );
  }
);
PhaseStatus.displayName = 'PhaseStatus';
