import { Button as FluentButton, makeStyles, mergeClasses, shorthands, Subtitle2, tokens } from '@fluentui/react-components';
import {
  ArrowLeft20Regular,
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
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import type { SelectTabData } from '@/renderer/ds';
import { Badge, Body1, Button, Caption1, IconButton, Input, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, Select, Tab, TabList } from '@/renderer/ds';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, TicketId, TicketPhase, TicketResolution } from '@/shared/types';

import { $pipeline, $tickets, ticketApi } from './state';
import { RESOLUTION_LABELS } from './ticket-constants';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketDiscussionTab } from './TicketDiscussionTab';
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

type TicketTab = 'Overview' | 'Discussion' | 'PR' | 'Artifacts';
const TABS: TicketTab[] = ['Overview', 'Discussion', 'PR', 'Artifacts'];

type DragHandleProps = {
  attributes: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  listeners: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type TicketDetailProps = {
  ticketId: TicketId;
  compact?: boolean;
  onClose?: () => void;
  closeBehavior?: 'close' | 'back';
  dragHandleProps?: DragHandleProps;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export const TicketDetail = memo(({ ticketId, compact, onClose, closeBehavior = 'close', dragHandleProps, isExpanded, onToggleExpand }: TicketDetailProps) => {
  const styles = useStyles();
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const store = useStore(persistedStoreApi.$atom);
  const ticket = tickets[ticketId];
  const project = useMemo(
    () => store.projects.find((p) => p.id === ticket?.projectId) ?? null,
    [store.projects, ticket?.projectId]
  );
  const [activeTab, setActiveTab] = useState<TicketTab>('Overview');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [editingBranch, setEditingBranch] = useState(false);
  const [editBranch, setEditBranch] = useState('');

  useEffect(() => {
    if (project?.source?.kind !== 'local') {
      setGitInfo(null);
      return;
    }
    ticketApi.checkGitRepo(project.source.workspaceDir).then((info) => {
      setGitInfo(info);
    });
  }, [project?.source]);

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
    setEditingBranch(true);
  }, [ticket]);

  const handleCancelEditBranch = useCallback(() => {
    setEditingBranch(false);
  }, []);

  const handleSaveBranch = useCallback(() => {
    if (!ticket) {
      return;
    }
    void ticketApi.updateTicket(ticketId, {
      branch: editBranch || undefined,
    });
    setEditingBranch(false);
  }, [editBranch, ticket, ticketId]);

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

  const handleOpenChat = useCallback(() => {
    void openTicketInCode(ticketId);
  }, [ticketId]);

  const handleStartAutopilot = useCallback(() => {
    void openTicketInCode(ticketId);
    void ticketApi.startSupervisor(ticketId);
  }, [ticketId]);

  const handleDelete = useCallback(() => {
    ticketApi.removeTicket(ticketId);
  }, [ticketId]);

  const isTerminalColumn = useMemo(() => {
    if (!pipeline || !ticket) {
      return false;
    }
    const terminalId = pipeline.columns[pipeline.columns.length - 1]?.id;
    return ticket.columnId === terminalId;
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
    setActiveTab(data.value as TicketTab);
  }, []);

  if (!ticket) {
    return (
      <div className={styles.notFound}>
        <Body1>Ticket not found</Body1>
      </div>
    );
  }

  const phase = ticket.phase;
  const showTabs = true;

  return (
    <div className={styles.root}>
      {/* ── Row 1: Title ── */}
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
        {onClose && (
          <IconButton
            aria-label={closeBehavior === 'back' ? 'Back' : 'Close'}
            icon={closeBehavior === 'back' ? <ArrowLeft20Regular /> : <Dismiss20Regular />}
            size="sm"
            onClick={onClose}
          />
        )}
      </div>

      {/* ── Row 2: Tabs + overflow menu ── */}
      <div className={styles.tabRow}>
        <TabList size="small" selectedValue={activeTab} onTabSelect={handleTabSelect} className={styles.tabList}>
          {TABS.map((tab) => (
            <Tab key={tab} value={tab}>{tab}</Tab>
          ))}
        </TabList>

        {!compact && (
          <Menu positioning={{ position: 'below', align: 'end', fallbackPositions: ['above-end'] }}>
            <MenuTrigger>
              <IconButton
                aria-label="Ticket menu"
                icon={<MoreHorizontal20Filled />}
                size="sm"
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {gitInfo?.isGitRepo && (
                  <MenuItem icon={<BranchFork20Regular />} onClick={handleStartEditBranch}>
                    Edit branch
                  </MenuItem>
                )}
                {!ticket.resolution && !isTerminalColumn && (
                  <>
                    <MenuDivider />
                    {(['completed', 'wont_do', 'duplicate', 'cancelled'] as TicketResolution[]).map((res) => (
                      <MenuItem key={res} onClick={() => handleResolve(res)}>
                        {RESOLUTION_LABELS[res]}
                      </MenuItem>
                    ))}
                  </>
                )}
                {ticket.resolution && (
                  <>
                    <MenuDivider />
                    {ticket.archivedAt ? (
                      <MenuItem onClick={handleUnarchive}>Unarchive ticket</MenuItem>
                    ) : (
                      <MenuItem onClick={handleArchive}>Archive ticket</MenuItem>
                    )}
                  </>
                )}
                <MenuDivider />
                <MenuItem icon={<Delete20Regular />} onClick={handleDelete}>
                  Delete ticket
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
            <Caption1 style={{ color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightMedium }}>Branch</Caption1>
            <Select
              value={editBranch}
              onChange={(e) => setEditBranch(e.target.value)}
              size="sm"
            >
              <option value="">None</option>
              {gitInfo.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </Select>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
            Tickets with a branch open in an isolated workspace.
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
          <TicketOverviewTab ticket={ticket} />
        </div>
      )}
      {activeTab === 'Discussion' && (
        <div className={styles.tabPane}>
          <TicketDiscussionTab ticket={ticket} />
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
    </div>
  );
});
TicketDetail.displayName = 'TicketDetail';

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
          Autopilot
        </Button>
      </div>
    );
  }
);
PhaseStatus.displayName = 'PhaseStatus';
