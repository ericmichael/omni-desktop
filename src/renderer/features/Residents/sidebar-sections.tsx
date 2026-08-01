import { Field, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Edit20Regular,
  MoreHorizontal20Regular,
  NumberSymbol20Regular,
  PeopleTeamRegular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  channelIdFromName,
  dmParticipants,
  RESERVED_CHANNEL_IDS,
  TEAM_CHANNEL,
  USER_PARTICIPANT,
} from '@/lib/resident-agent';
import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { NavSection } from '@/renderer/common/NavSection';
import {
  AnimatedDialog,
  Button,
  Caption1,
  ConfirmDialog,
  CounterBadge,
  DialogBody,
  DialogContent,
  DialogHeader,
  IconButton,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Tree,
  TreeItem,
  TreeItemLayout,
} from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ResidentChannelDef, ResidentChannelMessage } from '@/shared/types';

import type { AgentPresence } from './agent-avatar';
import { AgentAvatar, presenceStatus } from './agent-avatar';
import {
  $activityUnread,
  $residentStatus,
  $residentsView,
  $residentUnreadByChannel,
  goToActivity,
  goToResidentChannel,
  residentApi,
} from './state';

/**
 * The Channels and Direct-messages nav sections, self-contained (rows,
 * creation, dialogs, IPC) so the app sidebar and the Agents surface's
 * mobile list render the same components.
 */

const useStyles = makeStyles({
  rowActions: {
    display: 'flex',
    alignItems: 'center',
  },
  /* Unread rows follow the mainstream convention: weight, not just a badge. */
  unreadLabel: {
    fontWeight: tokens.fontWeightSemibold,
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  newChannelWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingBottom: '8px',
  },
  newChannelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '4px',
  },
  newChannelInput: {
    flex: '1 1 0',
  },
  newChannelHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  newChannelError: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    color: tokens.colorPaletteRedForeground1,
  },
  dialogForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  dialogButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
});

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

// ---------------------------------------------------------------------------
// Channel rows
// ---------------------------------------------------------------------------

const ChannelRow = memo(function ChannelRow({
  channelId,
  selected,
  manageable,
  unread,
  onSelect,
  onRequestEdit,
  onRequestDelete,
}: {
  channelId: string;
  selected: boolean;
  /** Built-ins (#team) take no edit/delete menu. */
  manageable: boolean;
  unread: number;
  onSelect: (id: string) => void;
  onRequestEdit: (id: string) => void;
  onRequestDelete: (id: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const [menuOpen, setMenuOpen] = useState(false);
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => setMenuOpen(data.open), []);
  const handleEdit = useCallback(() => onRequestEdit(channelId), [onRequestEdit, channelId]);
  const handleDelete = useCallback(() => onRequestDelete(channelId), [onRequestDelete, channelId]);
  return (
    <TreeItem
      itemType="leaf"
      value={`channel:${channelId}`}
      className={mergeClasses(nav.navItem, selected && nav.navItemSelected)}
      onClick={handleClick}
    >
      <TreeItemLayout
        iconBefore={<NumberSymbol20Regular />}
        aside={!selected && unread > 0 ? <CounterBadge count={unread} size="small" color="brand" /> : undefined}
        {...(manageable
          ? {
              actions: {
                // Fluent shows the actions slot on hover/focus; force it
                // while the menu is open so it doesn't vanish under the
                // popover (the Work sidebar's ProjectRow idiom).
                visible: menuOpen || undefined,
                children: (
                  <span
                    role="presentation"
                    className={styles.rowActions}
                    onClick={stopPropagation}
                    onMouseDown={stopPropagation}
                  >
                    <Menu
                      open={menuOpen}
                      onOpenChange={handleMenuOpenChange}
                      positioning={{ position: 'below', align: 'end' }}
                    >
                      <MenuTrigger disableButtonEnhancement>
                        <IconButton aria-label={`#${channelId} actions`} icon={<MoreHorizontal20Regular />} size="sm" />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem icon={<Edit20Regular />} onClick={handleEdit}>
                            Edit…
                          </MenuItem>
                          <MenuDivider />
                          <MenuItem icon={<Delete20Regular />} className={styles.dangerMenuItem} onClick={handleDelete}>
                            Delete…
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </span>
                ),
              },
            }
          : {})}
      >
        <span className={unread > 0 ? styles.unreadLabel : undefined}>{channelId}</span>
      </TreeItemLayout>
    </TreeItem>
  );
});

/**
 * Inline create row — rendered only while adding (the section header's "+"
 * toggles it). Previews the id slug live (names are slugified at creation and
 * fixed thereafter, like agent DM addresses); an exact match repurposes Enter
 * to OPEN the existing channel instead of erroring; create failures surface
 * inline and keep the row open.
 */
function NewChannelRow({
  existingIds,
  onDone,
  onOpen,
}: {
  existingIds: readonly string[];
  onDone: () => void;
  onOpen: (channelId: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const slug = trimmed ? channelIdFromName(trimmed) : null;
  const exists = slug !== null && existingIds.includes(slug);
  const reserved = slug !== null && !exists && RESERVED_CHANNEL_IDS.includes(slug);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setError(null);
  }, []);

  const create = useCallback(() => {
    if (!slug) {
      return;
    }
    if (exists) {
      onOpen(slug);
      onDone();
      return;
    }
    if (reserved) {
      return;
    }
    residentApi
      .createChannel(trimmed)
      .then((def) => {
        onOpen(def.id);
        onDone();
      })
      .catch((err: Error) => setError(err.message));
  }, [slug, exists, reserved, trimmed, onOpen, onDone]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        create();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDone();
      }
    },
    [create, onDone]
  );

  const hint = exists
    ? `#${slug} already exists — press Enter to open it`
    : reserved
      ? `#${slug} is reserved`
      : slug
        ? `Will be created as #${slug}`
        : null;

  return (
    <div className={styles.newChannelWrap}>
      <div className={styles.newChannelRow}>
        <Input
          className={styles.newChannelInput}
          value={name}
          placeholder="New channel…"
          autoFocus
          aria-label="New channel name"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <IconButton
          aria-label={exists ? `Open #${slug}` : 'Create channel'}
          size="sm"
          icon={<Add20Regular />}
          onClick={create}
        />
      </div>
      {error ? (
        <Caption1 className={styles.newChannelError}>{error}</Caption1>
      ) : (
        hint && <Caption1 className={styles.newChannelHint}>{hint}</Caption1>
      )}
    </div>
  );
}

/** Edit a channel's description — the id slug is fixed at creation (it is
 *  the address agents post to), so the dialog shows it read-only. */
function EditChannelDialog({
  channel,
  onClose,
}: {
  channel: ResidentChannelDef | null;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles();
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (channel) {
      setDescription(channel.description ?? '');
      setError(null);
    }
  }, [channel]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value), []);

  const save = useCallback(() => {
    if (!channel) {
      return;
    }
    setSaving(true);
    setError(null);
    residentApi
      .updateChannel(channel.id, { description })
      .then(onClose)
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, [channel, description, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    },
    [save]
  );

  return (
    <AnimatedDialog open={channel !== null} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Edit #{channel?.id}</DialogHeader>
        <DialogBody>
          <div className={styles.dialogForm}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Description" hint="One line — what this channel is for. Shown in the channel header.">
              <Input
                value={description}
                placeholder="Deploys, incidents, and release chatter"
                autoFocus
                onChange={handleChange}
                onKeyDown={handleKeyDown}
              />
            </Field>
            <div className={styles.dialogButtons}>
              <Button variant="primary" onClick={save} isDisabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={onClose} isDisabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </AnimatedDialog>
  );
}

/** The Channels nav section: header + "+", rows, inline create, dialogs. */
export function ChannelsSection({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const nav = useNavTreeStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const view = useStore($residentsView);
  const unreadByChannel = useStore($residentUnreadByChannel);

  const channelDefs = useMemo(() => storeData.residentChannelDefs ?? [], [storeData.residentChannelDefs]);
  const channelIds = useMemo(() => [TEAM_CHANNEL, ...channelDefs.map((c) => c.id)], [channelDefs]);
  const activityUnread = useStore($activityUnread);
  // Selection paints only while the Agents surface is frontmost — the atom
  // keeps its value across tab switches (keep-mounted panels).
  const selectedChannel = storeData.layoutMode === 'agents' ? view.selectedChannel : null;
  // Activity = the empty Agents view (nothing selected, no flags).
  const activityOpen =
    storeData.layoutMode === 'agents' &&
    view.selectedAgentId === null &&
    view.selectedChannel === null &&
    view.showHandbook !== true &&
    view.showRoster !== true &&
    view.showRoutines !== true &&
    view.showNewAgent !== true;

  const [adding, setAdding] = useState(false);
  const startAdd = useCallback(() => setAdding(true), []);
  const stopAdd = useCallback(() => setAdding(false), []);

  const [editing, setEditing] = useState<ResidentChannelDef | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const handleRequestEdit = useCallback(
    (channelId: string) => setEditing(channelDefs.find((c) => c.id === channelId) ?? null),
    [channelDefs]
  );

  // Channel deletion also purges the channel's message history — confirm.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const handleRequestDelete = useCallback((channelId: string) => setPendingDelete(channelId), []);
  const closeDelete = useCallback(() => setPendingDelete(null), []);
  const confirmDelete = useCallback(() => {
    const channelId = pendingDelete;
    if (!channelId) {
      return;
    }
    void residentApi.deleteChannel(channelId);
    if ($residentsView.get().selectedChannel === channelId) {
      $residentsView.set({ selectedAgentId: null, selectedChannel: null });
    }
  }, [pendingDelete]);

  const handleSelect = useCallback(
    (channelId: string) => {
      goToResidentChannel(channelId);
      onNavigate?.();
    },
    [onNavigate]
  );

  const handleActivity = useCallback(() => {
    goToActivity();
    onNavigate?.();
  }, [onNavigate]);

  // Aggregate attention for the collapsed header: unread across the named
  // channels (the Activity row's merged count would double-count them).
  const unreadTotal = channelIds.reduce((sum, id) => sum + (unreadByChannel[id] ?? 0), 0);

  return (
    <>
      <NavSection
        id="channels"
        label="Channels"
        collapsedBadge={unreadTotal}
        actions={<IconButton aria-label="New channel" icon={<Add20Regular />} size="sm" onClick={startAdd} />}
      >
        <Tree aria-label="Channels" className={nav.tree}>
          {/* The merged feed heads the things it merges (the Slack
            pseudo-channel idiom) — also the only entry to agent↔agent
            threads, via each message's conversation tag. */}
          <TreeItem
            itemType="leaf"
            value="activity"
            className={mergeClasses(nav.navItem, activityOpen && nav.navItemSelected)}
            onClick={handleActivity}
          >
            <TreeItemLayout
              iconBefore={<PeopleTeamRegular />}
              aside={
                !activityOpen && activityUnread > 0 ? (
                  <CounterBadge count={activityUnread} size="small" color="brand" />
                ) : undefined
              }
            >
              Activity
            </TreeItemLayout>
          </TreeItem>
          {channelIds.map((channelId) => (
            <ChannelRow
              key={channelId}
              channelId={channelId}
              selected={selectedChannel === channelId}
              manageable={channelId !== TEAM_CHANNEL}
              unread={unreadByChannel[channelId] ?? 0}
              onSelect={handleSelect}
              onRequestEdit={handleRequestEdit}
              onRequestDelete={handleRequestDelete}
            />
          ))}
        </Tree>
        {adding && <NewChannelRow existingIds={channelIds} onDone={stopAdd} onOpen={handleSelect} />}
      </NavSection>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title={`Delete #${pendingDelete ?? ''}?`}
        description="The channel and its message history are removed. This action cannot be undone."
        confirmLabel="Delete"
        destructive
      />
      <EditChannelDialog channel={editing} onClose={closeEdit} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

/** Sidebar DM nav row: the peer's avatar (with live presence) sits in the
 *  tree's icon gutter — single-line, like every nav row. */
const DmNavRow = memo(function DmNavRow({
  channelId,
  title,
  avatar,
  presence,
  selected,
  unread,
  onSelect,
}: {
  channelId: string;
  title: string;
  avatar: { name: string; colorId: string };
  presence?: AgentPresence;
  selected: boolean;
  unread: number;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  return (
    <TreeItem
      itemType="leaf"
      value={channelId}
      className={mergeClasses(nav.navItem, selected && nav.navItemSelected)}
      onClick={handleClick}
    >
      <TreeItemLayout
        iconBefore={
          <AgentAvatar name={avatar.name} colorId={avatar.colorId} size={20} {...(presence ? { presence } : {})} />
        }
        aside={!selected && unread > 0 ? <CounterBadge count={unread} size="small" color="brand" /> : undefined}
      >
        <span className={unread > 0 ? styles.unreadLabel : undefined}>{title}</span>
      </TreeItemLayout>
    </TreeItem>
  );
});

/**
 * The Direct-messages nav section: the Slack contract — only YOUR live
 * threads, plus the just-opened empty thread (start-a-DM) so the selection
 * has a row while the first message is being written. Hidden entirely when
 * there are no rows. Agent↔agent threads are observed via Activity and each
 * agent's Conversations tab.
 */
export function DmsSection({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element | null {
  const nav = useNavTreeStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const statuses = useStore($residentStatus);
  const view = useStore($residentsView);
  const unreadByChannel = useStore($residentUnreadByChannel);
  const roster = useMemo(() => storeData.residentAgents ?? [], [storeData.residentAgents]);

  // Latest message per user↔agent thread, newest first.
  const threadIds = useMemo(() => {
    const latest = new Map<string, ResidentChannelMessage>();
    for (const m of storeData.residentChannels ?? []) {
      if (dmParticipants(m.channel)?.includes(USER_PARTICIPANT)) {
        latest.set(m.channel, m);
      }
    }
    return [...latest.entries()].sort((a, b) => b[1].at - a[1].at).map(([id]) => id);
  }, [storeData.residentChannels]);

  const rows = useMemo(() => {
    const out = [...threadIds];
    const selected = view.selectedChannel;
    if (selected && dmParticipants(selected)?.includes(USER_PARTICIPANT) && !out.includes(selected)) {
      out.unshift(selected);
    }
    return out;
  }, [threadIds, view.selectedChannel]);

  const handleSelect = useCallback(
    (channelId: string) => {
      goToResidentChannel(channelId);
      onNavigate?.();
    },
    [onNavigate]
  );

  // Selection paints only while the Agents surface is frontmost.
  const selectedChannel = storeData.layoutMode === 'agents' ? view.selectedChannel : null;

  if (rows.length === 0) {
    return null;
  }

  // Aggregate attention for the collapsed header: unread across the threads.
  const unreadTotal = rows.reduce((sum, id) => sum + (unreadByChannel[id] ?? 0), 0);

  return (
    <NavSection id="dms" label="Direct messages" collapsedBadge={unreadTotal}>
      <Tree aria-label="Direct messages" className={nav.tree}>
        {rows.map((channelId) => {
          const peerId = dmParticipants(channelId)?.find((p) => p !== USER_PARTICIPANT);
          const peer = peerId ? roster.find((a) => a.id === peerId) : undefined;
          const title = peer?.name ?? peerId ?? 'You';
          const presence = peerId ? presenceStatus(statuses[peerId]?.state, peer?.enabled ?? true) : undefined;
          return (
            <DmNavRow
              key={channelId}
              channelId={channelId}
              title={title}
              avatar={{ name: title, colorId: peerId ?? USER_PARTICIPANT }}
              {...(presence ? { presence } : {})}
              selected={selectedChannel === channelId}
              unread={unreadByChannel[channelId] ?? 0}
              onSelect={handleSelect}
            />
          );
        })}
      </Tree>
    </NavSection>
  );
}
