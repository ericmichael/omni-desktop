import { useStore } from '@nanostores/react';
import { Edit, Ellipsis, Hash, Plus, Trash2, UsersRound } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  channelIdFromName,
  dmParticipants,
  RESERVED_CHANNEL_IDS,
  TEAM_CHANNEL,
  USER_PARTICIPANT,
} from '@/lib/resident-agent';
import { NavSection } from '@/renderer/common/NavSection';
import { SidebarRow, SidebarRowActions } from '@/renderer/common/SidebarRow';
import { cn } from '@/renderer/ds/cn';
import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
} from '@/renderer/ds/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ResidentChannelDef, ResidentChannelMessage } from '@/shared/types';

import type { AgentPresence } from './agent-avatar';
import { AgentAvatar, AgentPresenceBadge, presenceStatus } from './agent-avatar';
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
  /** Built-ins (#team) take no edit/delete menu. */ manageable: boolean;
  unread: number;
  onSelect: (id: string) => void;
  onRequestEdit: (id: string) => void;
  onRequestDelete: (id: string) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  const handleMenuOpenChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const handleEdit = useCallback(() => onRequestEdit(channelId), [onRequestEdit, channelId]);
  const handleDelete = useCallback(() => onRequestDelete(channelId), [onRequestDelete, channelId]);
  return (
    <SidebarRow>
      <SidebarMenuButton type="button" isActive={selected} onClick={handleClick}>
        <Hash />
        <span className={cn('min-w-0 flex-1 truncate', unread > 0 && 'font-semibold')}>{channelId}</span>
      </SidebarMenuButton>
      {!selected && unread > 0 && <SidebarMenuBadge className="h-4 min-w-4 text-xs">{unread}</SidebarMenuBadge>}
      {manageable && (
        <SidebarRowActions open={menuOpen}>
          <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction aria-label={`#${channelId} actions`}>
                    <Ellipsis />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Channel actions
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={handleEdit}>
                <Edit />
                Edit…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={handleDelete}>
                <Trash2 />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarRowActions>
      )}
    </SidebarRow>
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
    <div className="flex flex-col gap-0.5 pb-2">
      <div className="flex items-center gap-2 px-2 pt-1 pl-5">
        <Input
          className="flex-1"
          value={name}
          placeholder="New channel…"
          autoFocus
          aria-label="New channel name"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={exists ? `Open #${slug}` : 'Create channel'}
          onClick={create}
        >
          <Plus />
        </Button>
      </div>
      {error ? (
        <span className="px-5 text-xs text-destructive">{error}</span>
      ) : (
        hint && <span className="px-5 text-xs text-muted-foreground">{hint}</span>
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
    <Dialog open={channel !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit #{channel?.id}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input
                value={description}
                placeholder="Deploys, incidents, and release chatter"
                autoFocus
                onChange={handleChange}
                onKeyDown={handleKeyDown}
              />
              <FieldDescription>One line — what this channel is for. Shown in the channel header.</FieldDescription>
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="default" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Channels nav section: header + "+", rows, inline create, dialogs. */
export function ChannelsSection({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
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
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction aria-label="New channel" onClick={startAdd}>
                <Plus />
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              New channel
            </TooltipContent>
          </Tooltip>
        }
      >
        <SidebarMenu aria-label="Channels">
          {/* The merged feed heads the things it merges (the Slack
                pseudo-channel idiom) — also the only entry to agent↔agent
                threads, via each message's conversation tag. */}
          <SidebarRow>
            <SidebarMenuButton type="button" isActive={activityOpen} onClick={handleActivity}>
              <UsersRound />
              <span className="min-w-0 flex-1 truncate">Activity</span>
            </SidebarMenuButton>
            {!activityOpen && activityUnread > 0 && (
              <SidebarMenuBadge className="h-4 min-w-4 text-xs">{activityUnread}</SidebarMenuBadge>
            )}
          </SidebarRow>
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
        </SidebarMenu>
        {adding && <NewChannelRow existingIds={channelIds} onDone={stopAdd} onOpen={handleSelect} />}
      </NavSection>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && closeDelete()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete #${pendingDelete ?? ''}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              The channel and its message history are removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  return (
    <SidebarRow>
      <SidebarMenuButton type="button" isActive={selected} onClick={handleClick}>
        <span className="shrink-0">
          <AgentAvatar name={avatar.name} colorId={avatar.colorId} size={20} />
        </span>
        <span className={cn('min-w-0 flex-1 truncate', unread > 0 && 'font-semibold')}>{title}</span>
      </SidebarMenuButton>
      {(!selected && unread > 0) || presence ? (
        <SidebarMenuBadge className="gap-1 px-0">
          {presence ? <AgentPresenceBadge presence={presence} /> : null}
          {!selected && unread > 0 ? <span aria-label={`${unread} unread`}>{unread}</span> : null}
        </SidebarMenuBadge>
      ) : null}
    </SidebarRow>
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
      <SidebarMenu aria-label="Direct messages">
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
      </SidebarMenu>
    </NavSection>
  );
}
