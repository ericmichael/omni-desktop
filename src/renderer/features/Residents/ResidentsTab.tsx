import { useStore } from '@nanostores/react';
import {
  BookOpen,
  Brain,
  Check,
  Ellipsis,
  FolderKanban,
  MessageCircle,
  Mic,
  Plus,
  Reply,
  Send,
  Speaker,
  Terminal,
  Trash2,
  UserPlus,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import type { ChangeEvent, ComponentProps, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatDayLabel, formatTimeOfDay, formatTimestamp } from '@/lib/format-time';
import {
  dmChannelId,
  dmParticipants,
  memoryKey,
  parseResidentPrincipal,
  residentHandle,
  SYSTEM_CHANNEL,
  TEAM_CHANNEL,
  USER_PARTICIPANT,
} from '@/lib/resident-agent';
import { RESIDENT_TEMPLATES } from '@/lib/resident-templates';
import { configuredVoiceMode } from '@/lib/voice-mode';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { cn } from '@/renderer/ds/cn';
import { PageTabsList, PageTabsTrigger } from '@/renderer/ds/PageTabs';
import { SaveBar } from '@/renderer/ds/SaveBar';
import { TopAppBar } from '@/renderer/ds/TopAppBar';
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
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Command, CommandItem, CommandList } from '@/renderer/ds/ui/command';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/renderer/ds/ui/item';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Popover, PopoverAnchor, PopoverContent } from '@/renderer/ds/ui/popover';
import { Separator } from '@/renderer/ds/ui/separator';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Switch } from '@/renderer/ds/ui/switch';
import { Tabs } from '@/renderer/ds/ui/tabs';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { ScheduledTasks } from '@/renderer/features/ScheduledTasks/ScheduledTasks';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { LocalVoiceButton } from '@/renderer/omniagents-ui/components/LocalVoiceButton';
import { VoiceModal } from '@/renderer/omniagents-ui/components/VoiceModal';
import { MarkdownMessage } from '@/renderer/omniagents-ui/shared/MarkdownMessage';
import { UiConfigProvider } from '@/renderer/omniagents-ui/ui-config';
import { emitter, serverOrigin } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { VoiceScopeContext } from '@/renderer/services/voice-recording';
import type {
  AgentRuntimeConnection,
  Project,
  ResidentAgent,
  ResidentAgentRuntime,
  ResidentChannelMessage,
} from '@/shared/types';

import type { AgentPresence } from './agent-avatar';
import { AgentAvatar, AgentAvatarGroup, participantPresence, PRESENCE_LABEL, presenceStatus } from './agent-avatar';
import { $dmSpokenReplies, speakDmMessage, toggleDmSpokenReplies } from './dm-voice';
import {
  $residentStatus,
  $residentsView,
  goToHandbook,
  goToNewAgent,
  goToResidentChannel,
  goToRoster,
  markResidentMessagesSeen,
  residentApi,
  syncResidentStatus,
} from './state';

type SandboxContext = ComponentProps<typeof SandboxPicker>['context'];

const MORNING_HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);

const STATE_LABEL: Record<ResidentAgentRuntime['state'], string> = {
  parked: 'Parked',
  starting: 'Starting…',
  idle: 'Idle',
  thinking: 'Thinking…',
  reflecting: 'Reflecting…',
};

function availabilityLabel(runtime: ResidentAgentRuntime | undefined, enabled: boolean): string {
  if (!enabled) {
    return 'Unavailable';
  }
  if (runtime?.state === 'thinking' || runtime?.state === 'reflecting') {
    return 'Working';
  }
  if (runtime?.state === 'starting') {
    return 'Getting ready';
  }
  return 'Available';
}

/** Field label with the doctrine tucked behind an info icon — labels stay
 *  scannable, the manual stays available. */
const infoLabel = (text: string, info: string): ReactNode => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="inline-flex items-center gap-1">
        {text}
        <span className="text-muted-foreground" aria-hidden="true">
          ⓘ
        </span>
      </span>
    </TooltipTrigger>
    <TooltipContent>{info}</TooltipContent>
  </Tooltip>
);

/** Human label for a channel: null for #team, "you ↔ Scout" for DMs. */
const channelLabel = (channel: string, roster: ResidentAgent[]): string | null => {
  if (channel === TEAM_CHANNEL) {
    return null;
  }
  const pair = dmParticipants(channel);
  if (!pair) {
    return `#${channel}`;
  }
  const nameOf = (p: string): string => (p === USER_PARTICIPANT ? 'you' : (roster.find((a) => a.id === p)?.name ?? p));
  return `${nameOf(pair[0])} ↔ ${nameOf(pair[1])}`;
};

/** One row of the @-mention typeahead. Mouse-down (not click) so the pick
 *  lands before the textarea's blur dismisses the popup. */
const MentionItem = memo(function MentionItem({
  agent,
  index,
  active,
  presence,
  onPick,
  onHover,
}: {
  agent: ResidentAgent;
  index: number;
  active: boolean;
  /** Live presence — who you're about to address is worth knowing here. */ presence?: AgentPresence;
  onPick: (agent: ResidentAgent) => void;
  onHover: (index: number) => void;
}): React.JSX.Element {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onPick(agent);
    },
    [onPick, agent]
  );
  const handleMouseEnter = useCallback(() => onHover(index), [onHover, index]);
  return (
    <CommandItem
      value={agent.id}
      className={cn(
        'flex items-center gap-2 w-full border-0 bg-transparent text-left cursor-pointer pt-1 pb-1 pl-4 pr-4 text-sm',
        active && 'bg-accent'
      )}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
    >
      <AgentAvatar name={agent.name} colorId={agent.id} size={24} {...(presence ? { presence } : {})} />
      <span>{agent.name}</span>
      <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
        {agent.role}
      </span>
    </CommandItem>
  );
});

// ---------------------------------------------------------------------------
// Activity feed — ALL channel traffic (#team + every DM thread), the
// observability surface. The composer posts to #team.
// ---------------------------------------------------------------------------

/** Replies shown per collapsed thread (the newest ones); the rest sit
 *  behind an "earlier replies" expander. */
const VISIBLE_REPLY_TAIL = 3;

/** Messages this close together from the same sender coalesce into one
 *  visual group — avatar and header on the first row only. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** May `cur` render as a continuation of `prev`? Incidents never coalesce —
 *  each one must land with its own full header. */
const sameGroup = (prev: ResidentChannelMessage, cur: ResidentChannelMessage): boolean =>
  prev.from === cur.from &&
  prev.channel === cur.channel &&
  cur.channel !== SYSTEM_CHANNEL &&
  cur.at - prev.at < GROUP_WINDOW_MS;

/** One row of the channel feed: a message (root or indented reply, head or
 *  grouped continuation), the collapsed-thread expander, or a day divider. */
type FeedItem =
  | { kind: 'message'; msg: ResidentChannelMessage; indent: boolean; groupHead: boolean; replyCount?: number }
  | { kind: 'expand'; rootId: number; hiddenCount: number }
  | { kind: 'day'; ts: number };

function ActivityFeed({
  roster,
  channel,
  readOnly = false,
  onOpenChannel,
}: {
  roster: ResidentAgent[];
  channel?: string;
  /** Agent↔agent DM threads are observed, not joined — no composer. */ readOnly?: boolean;
  /** All-traffic view only: makes each row's conversation tag a click
   *  target that opens the channel/thread it names. */ onOpenChannel?: (channelId: string) => void;
}): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);
  // Same presence source as the sidebar — every avatar this feed paints
  // (message gutters, the @-mention typeahead) reads from it, so a state
  // change repaints them all together.
  const statuses = useStore($residentStatus);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  // The message a composed post replies to (named channels only). Send
  // normalizes to the thread root; the manager re-normalizes regardless.
  const [replyTarget, setReplyTarget] = useState<ResidentChannelMessage | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Stick-to-bottom only while the user IS at the bottom — new traffic must
  // not yank someone who scrolled up to read history.
  const atBottomRef = useRef(true);

  // A DM thread's composer addresses the peer by name, not a channel id.
  const dmPair = channel ? dmParticipants(channel) : null;
  // Threads live in named channels; the Activity view and DMs stay flat.
  const isNamedChannel = !!channel && !dmPair;
  const dmPeerId = dmPair?.find((p) => p !== USER_PARTICIPANT);
  const dmPeerName = dmPeerId ? (roster.find((a) => a.id === dmPeerId)?.name ?? dmPeerId) : null;

  // Voice lives on the DM surface (user↔agent threads only): mic in the
  // composer for input, spoken replies for output — the agent's reply IS
  // the DM message, so the surface reads it aloud; no session plumbing.
  const isUserDm = dmPair !== null && dmPair.includes(USER_PARTICIPANT);
  const voiceMode = configuredVoiceMode(storeData);
  const voiceReady = isUserDm && voiceMode === 'local' && isLocalVoiceCapable();
  // Hosted mode: the realtime VoiceModal against the DM peer's own serve.
  const hostedVoiceReady = isUserDm && voiceMode === 'hosted' && !!dmPeerId;
  const [hostedVoiceOpen, setHostedVoiceOpen] = useState(false);
  const openHostedVoice = useCallback(() => setHostedVoiceOpen(true), []);
  const closeHostedVoice = useCallback(() => setHostedVoiceOpen(false), []);
  const spokenOn = Boolean(useStore($dmSpokenReplies)[channel ?? '']);

  // Threads a user chose to expand (session-local, per feed).
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<number>>(() => new Set());

  // @-mention typeahead: the "@word" being typed at the caret, if any.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Switching feeds drops any half-set reply context and expansion state —
  // both belong to the channel they were picked in.
  useEffect(() => {
    setReplyTarget(null);
    setSendError(null);
    setExpandedThreads(new Set());
    setMention(null);
  }, [channel]);

  // No channel = the all-traffic Activity view; otherwise one channel's feed.
  const messages = useMemo(
    () => (storeData.residentChannels ?? []).filter((m) => !channel || m.channel === channel),
    [storeData.residentChannels, channel]
  );

  // Root lookup for reply markers (all-view rows and orphaned replies).
  const messageById = useMemo(() => {
    const map = new Map<number, ResidentChannelMessage>();
    for (const m of storeData.residentChannels ?? []) {
      map.set(m.id, m);
    }
    return map;
  }, [storeData.residentChannels]);

  /**
   * Display order. Named channels group replies under their roots and BUMP
   * each thread to its latest activity (the forum-bump model): a new reply
   * moves its whole thread to the bottom, where the stick-to-bottom scroll
   * is looking — "new is at the bottom" holds at thread granularity. Long
   * threads collapse to the root + the newest replies behind an expander.
   * A reply whose root was pruned from the bounded log renders top-level
   * with a marker. The Activity view stays strictly chronological: it is
   * the record, and records don't reorder.
   */
  const feedItems = useMemo((): FeedItem[] => {
    if (!isNamedChannel) {
      // Flat chronological feeds (Activity, DMs) get day dividers and
      // consecutive-sender grouping — a day break also breaks the group.
      const out: FeedItem[] = [];
      let prev: ResidentChannelMessage | null = null;
      for (const msg of messages) {
        if (!prev || new Date(prev.at).toDateString() !== new Date(msg.at).toDateString()) {
          out.push({ kind: 'day', ts: msg.at });
          prev = null;
        }
        out.push({ kind: 'message', msg, indent: false, groupHead: !prev || !sameGroup(prev, msg) });
        prev = msg;
      }
      return out;
    }
    const rootIds = new Set(messages.filter((m) => m.replyTo === undefined).map((m) => m.id));
    const repliesByRoot = new Map<number, ResidentChannelMessage[]>();
    for (const m of messages) {
      if (m.replyTo !== undefined && rootIds.has(m.replyTo)) {
        const group = repliesByRoot.get(m.replyTo) ?? [];
        group.push(m);
        repliesByRoot.set(m.replyTo, group);
      }
    }
    const threads: { top: ResidentChannelMessage; replies: ResidentChannelMessage[]; lastAt: number }[] = [];
    for (const m of messages) {
      if (m.replyTo !== undefined && rootIds.has(m.replyTo)) {
        continue; // rendered under its root below
      }
      const replies = repliesByRoot.get(m.id) ?? [];
      threads.push({ top: m, replies, lastAt: replies.reduce((max, r) => Math.max(max, r.at), m.at) });
    }
    threads.sort((a, b) => a.lastAt - b.lastAt || a.top.id - b.top.id);
    // Thread order is forum-bump, not chronological, so no day dividers
    // here; roots are thread anchors and never render as continuations.
    const out: FeedItem[] = [];
    for (const t of threads) {
      out.push({
        kind: 'message',
        msg: t.top,
        indent: false,
        groupHead: true,
        ...(t.replies.length > 0 ? { replyCount: t.replies.length } : {}),
      });
      const collapsed = t.replies.length > VISIBLE_REPLY_TAIL && !expandedThreads.has(t.top.id);
      if (collapsed) {
        out.push({ kind: 'expand', rootId: t.top.id, hiddenCount: t.replies.length - VISIBLE_REPLY_TAIL });
      }
      const visible = collapsed ? t.replies.slice(-VISIBLE_REPLY_TAIL) : t.replies;
      let prevReply: ResidentChannelMessage | null = null;
      for (const reply of visible) {
        out.push({
          kind: 'message',
          msg: reply,
          indent: true,
          groupHead: !prevReply || !sameGroup(prevReply, reply),
        });
        prevReply = reply;
      }
    }
    return out;
  }, [messages, isNamedChannel, expandedThreads]);

  const handleExpandThread = useCallback((rootId: number) => {
    setExpandedThreads((prev) => new Set(prev).add(rootId));
  }, []);

  const handleFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (el) {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }
  }, []);

  useEffect(() => {
    if (atBottomRef.current) {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
    }
    // Everything rendered is now seen — advance this view's channel cursors.
    markResidentMessagesSeen(messages);
  }, [messages]);

  // Spoken replies: read aloud agent-authored rows that land while this DM
  // is open. Seeded to the newest row on mount/channel switch so history is
  // never read back.
  const lastSpokenIdRef = useRef<number | null>(null);
  useEffect(() => {
    lastSpokenIdRef.current = null;
  }, [channel]);
  useEffect(() => {
    const maxId = messages.reduce((max, m) => Math.max(max, m.id), 0);
    const since = lastSpokenIdRef.current;
    lastSpokenIdRef.current = maxId;
    if (since === null || !spokenOn || !dmPeerId) {
      return;
    }
    for (const m of messages) {
      if (m.id > since && m.from === dmPeerId) {
        speakDmMessage(m.text);
      }
    }
  }, [messages, spokenOn, dmPeerId]);

  const handleReplyClick = useCallback((m: ResidentChannelMessage) => {
    setReplyTarget(m);
    composerRef.current?.focus();
  }, []);

  const clearReply = useCallback(() => setReplyTarget(null), []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    const replyTo = replyTarget ? (replyTarget.replyTo ?? replyTarget.id) : undefined;
    setDraft('');
    setReplyTarget(null);
    setSendError(null);
    setMention(null);
    // Sending implies "take me to the conversation" even if scrolled up.
    atBottomRef.current = true;
    residentApi.post(channel ?? TEAM_CHANNEL, text, replyTo).catch((err: Error) => {
      // A failed send must not eat the message: restore the draft and say why.
      setDraft(text);
      setSendError(err.message);
    });
  }, [draft, channel, replyTarget]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      submit();
    },
    [submit]
  );

  // Voice input: the transcript sends as a normal DM post — the resident
  // hears it through the standard wake ping, no session-level plumbing.
  const handleVoiceSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      setSendError(null);
      atBottomRef.current = true;
      residentApi.post(channel ?? TEAM_CHANNEL, trimmed).catch((err: Error) => {
        // A failed send must not eat the transcript: surface it as the draft.
        setDraft(trimmed);
        setSendError(err.message);
      });
    },
    [channel]
  );

  const handleToggleSpoken = useCallback(() => {
    if (channel) {
      toggleDmSpokenReplies(channel);
    }
  }, [channel]);

  // Mention candidates for the token being typed (prefix on handle or name).
  const mentionCandidates = useMemo((): ResidentAgent[] => {
    if (!mention) {
      return [];
    }
    const q = mention.query.toLowerCase();
    return roster.filter((a) => residentHandle(a.name).startsWith(q) || a.name.toLowerCase().startsWith(q));
  }, [mention, roster]);

  const handleDraftChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      setDraft(el.value);
      setSendError(null);
      // A DM already addresses its peer — no mention typeahead there.
      if (dmPair) {
        return;
      }
      const caret = el.selectionStart ?? el.value.length;
      const match = /(^|\s)@([a-z0-9][a-z0-9-]*)?$/i.exec(el.value.slice(0, caret));
      if (match) {
        const query = match[2] ?? '';
        setMention({ query, start: caret - query.length - 1 });
        setMentionIndex(0);
      } else {
        setMention(null);
      }
    },
    [dmPair]
  );

  /** Replace the typed "@word" with the picked agent's canonical @handle. */
  const acceptMention = useCallback(
    (agent: ResidentAgent) => {
      if (!mention) {
        return;
      }
      const handle = residentHandle(agent.name);
      const caret = composerRef.current?.selectionStart ?? draft.length;
      setDraft(`${draft.slice(0, mention.start)}@${handle} ${draft.slice(caret)}`);
      setMention(null);
      const pos = mention.start + handle.length + 2;
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(pos, pos);
        }
      });
    },
    [mention, draft]
  );

  const dismissMention = useCallback(() => setMention(null), []);

  // Typeahead keys win while the popup is up; then Enter sends, Shift+Enter
  // inserts a newline, and Escape backs out of a reply.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention && mentionCandidates.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          setMentionIndex((i) => (i + delta + mentionCandidates.length) % mentionCandidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const picked = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
          if (picked) {
            acceptMention(picked);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMention(null);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && replyTarget) {
        e.preventDefault();
        clearReply();
      }
    },
    [submit, replyTarget, clearReply, mention, mentionCandidates, mentionIndex, acceptMention]
  );

  const composerLabel = dmPeerName
    ? `Message ${dmPeerName}`
    : replyTarget
      ? 'Reply in thread…'
      : `Message #${channel ?? TEAM_CHANNEL}`;
  const participantName = (m: ResidentChannelMessage): string =>
    m.from === USER_PARTICIPANT ? 'you' : (m.fromName ?? m.from);
  /** Presence for a message's sender — `undefined` for you, #system, and
   *  agents that have since left the roster (no live identity to report). */
  const senderPresence = (m: ResidentChannelMessage): AgentPresence | undefined =>
    participantPresence(m.from, roster, statuses);

  return (
    <>
      <div
        ref={feedRef}
        className="flex-1 min-h-0 overflow-y-auto pl-5 pr-5 pt-2 pb-2 flex flex-col"
        onScroll={handleFeedScroll}
      >
        {messages.length === 0 ? (
          channel ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">
                  {dmPair ? 'No messages in this thread yet' : `No messages in #${channel} yet`}
                </EmptyTitle>
                <EmptyDescription>
                  {dmPair
                    ? undefined
                    : 'Posts reach the channel’s members on their next wakeup; mention an agent by name to wake it now.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">No activity yet</EmptyTitle>
                <EmptyDescription>
                  Everything your agents say — in #team and to each other — lands here. Posting mentions an agent by
                  name to address it directly.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          feedItems.map((item) => {
            if (item.kind === 'day') {
              return (
                <div
                  key={`day-${item.ts}`}
                  className={cn('shrink-0 pt-5 pb-1 text-xs text-muted-foreground', 'flex items-center gap-2')}
                >
                  <Separator className="flex-1" />
                  <span className="text-xs text-muted-foreground">{formatDayLabel(item.ts)}</span>
                  <Separator className="flex-1" />
                </div>
              );
            }
            if (item.kind === 'expand') {
              return (
                <div key={`expand-${item.rootId}`} className="ml-6 pl-4 border-l-2 border-border">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="border-0 bg-transparent cursor-pointer py-0.5 text-muted-foreground text-xs rounded-lg hover:text-primary focus-visible:outline-2 outline-primary focus-visible:outline-offset-1"
                    onClick={handleExpandThread.bind(null, item.rootId)}
                  >
                    Show {item.hiddenCount} earlier {item.hiddenCount === 1 ? 'reply' : 'replies'}
                  </Button>
                </div>
              );
            }
            const { msg: m, indent, groupHead, replyCount } = item;
            const label = channel ? null : channelLabel(m.channel, roster);
            // #system rows are incident reports (declined approvals, failed
            // deliveries) — they must not read like ordinary chatter.
            const isIncident = m.channel === SYSTEM_CHANNEL;
            // Replies not nested under a visible root (the Activity view, or
            // an orphan whose root aged out of the log) carry a marker.
            const rootMsg = m.replyTo !== undefined ? messageById.get(m.replyTo) : undefined;
            const showReplyMarker = m.replyTo !== undefined && !indent;
            const fromName = participantName(m);
            const fromPresence = senderPresence(m);
            return (
              <div
                key={m.id}
                className={cn(
                  'relative flex gap-2 pt-0.5 pb-0.5 pl-1 pr-1 rounded-lg hover:bg-accent [&:hover_.message-actions]:opacity-100 [&:focus-within_.message-actions]:opacity-100',
                  indent && 'ml-6 pl-4 border-l-2 border-border',
                  isIncident && 'rounded-lg border-l-4 border-warning/50 bg-warning/10 px-2 py-1',
                  groupHead && 'mt-4'
                )}
              >
                <div className={cn('shrink-0 pt-0.5', indent ? 'w-6' : 'w-8')}>
                  {groupHead && (
                    <AgentAvatar
                      name={m.from === USER_PARTICIPANT ? 'You' : fromName}
                      colorId={m.from}
                      size={indent ? 24 : 32}
                      {...(fromPresence ? { presence: fromPresence } : {})}
                    />
                  )}
                </div>
                <div className="min-w-0 flex flex-col">
                  {groupHead && (
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-semibold text-sm">{m.from === USER_PARTICIPANT ? 'You' : fromName}</span>
                      {/* Incident (#system) tags stay inert — `system` is a
                    reserved id with no channel view to open. */}
                      {label &&
                        (onOpenChannel && !isIncident ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="border-0 bg-transparent p-0 cursor-pointer inline-flex rounded-lg focus-visible:outline-2 outline-primary focus-visible:outline-offset-1"
                            aria-label={`Open ${label}`}
                            onClick={onOpenChannel.bind(null, m.channel)}
                          >
                            <Badge variant="secondary">{label}</Badge>
                          </Button>
                        ) : (
                          <Badge variant="secondary">{label}</Badge>
                        ))}
                      {showReplyMarker && (
                        <span className="text-muted-foreground text-xs" title={rootMsg ? rootMsg.text : undefined}>
                          ↳ replying to {rootMsg ? participantName(rootMsg) : 'an earlier message'}
                        </span>
                      )}
                      {replyCount !== undefined && (
                        <span className="text-muted-foreground text-xs">
                          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {isNamedChannel ? formatTimestamp(m.at) : formatTimeOfDay(m.at)}
                      </span>
                    </div>
                  )}
                  <MarkdownMessage content={m.text} className="text-sm leading-5" />
                </div>
                {isNamedChannel && !readOnly && (
                  <div
                    className={cn(
                      'absolute -top-3 right-2 opacity-0 transition-opacity duration-100 bg-background border border-border rounded-lg shadow-sm [@media(hover:none)]:opacity-100',
                      'message-actions'
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Reply to ${fromName} in a thread`}
                      onClick={handleReplyClick.bind(null, m)}
                      title={`Reply to ${fromName} in a thread`}
                    >
                      <Reply />
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {readOnly ? (
        <div className="px-5 py-4 border-t border-border text-muted-foreground text-xs">
          An agent-to-agent thread — you’re observing. Post in #team (or DM an agent) to join the conversation.
        </div>
      ) : (
        <Popover
          open={mention !== null && mentionCandidates.length > 0}
          onOpenChange={(open) => !open && dismissMention()}
        >
          <PopoverAnchor asChild>
            <div className="relative border-t border-border">
              {replyTarget && (
                <div className="flex items-center gap-2 pl-5 pr-2 pt-1">
                  <span
                    className={cn(
                      'text-xs text-muted-foreground',
                      'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
                    )}
                  >
                    Replying to {participantName(replyTarget)} — “{replyTarget.text.slice(0, 80)}”
                  </span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel reply" onClick={clearReply}>
                    <X />
                  </Button>
                </div>
              )}
              {sendError && (
                <span className={cn('text-xs text-muted-foreground', 'pl-5 pr-5 pt-1 text-destructive')}>
                  {sendError}
                </span>
              )}
              <form className="flex items-end gap-2 p-5" onSubmit={handleSubmit}>
                <Textarea
                  ref={composerRef}
                  className="flex-1"
                  value={draft}
                  rows={1}
                  placeholder={composerLabel}
                  onChange={handleDraftChange}
                  onKeyDown={handleKeyDown}
                  onBlur={dismissMention}
                  aria-label={dmPeerName ? `Message ${dmPeerName}` : `Message #${channel ?? TEAM_CHANNEL}`}
                />

                {voiceReady && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={spokenOn ? 'Spoken replies on' : 'Spoken replies off'}
                      onClick={handleToggleSpoken}
                      title={
                        spokenOn
                          ? `Stop reading ${dmPeerName ?? 'agent'} replies aloud`
                          : 'Read replies aloud in this DM'
                      }
                    >
                      {spokenOn ? <Speaker /> : <VolumeX />}
                    </Button>

                    {/* Scope = the DM channel id: the mic registry keys the voice
              hotkey and recording glow by it (same registry the deck
              columns use). */}
                    <VoiceScopeContext.Provider value={channel ?? null}>
                      <LocalVoiceButton onSubmit={handleVoiceSubmit} />
                    </VoiceScopeContext.Provider>
                  </>
                )}
                {hostedVoiceReady && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Voice mode"
                    onClick={openHostedVoice}
                    title={`Talk with ${dmPeerName ?? 'agent'}`}
                  >
                    <Mic />
                  </Button>
                )}
                <Button type="button" variant="ghost" size="icon" aria-label="Send" onClick={submit}>
                  <Send />
                </Button>
              </form>
              {hostedVoiceOpen && dmPeerId && (
                <ResidentHostedVoice agentId={dmPeerId} onClose={closeHostedVoice} onError={setSendError} />
              )}
            </div>
          </PopoverAnchor>
          {mention && mentionCandidates.length > 0 && (
            <PopoverContent
              side="top"
              align="start"
              className="max-h-60 min-w-64 overflow-y-auto p-1"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <Command label="Mention an agent" shouldFilter={false}>
                <CommandList>
                  {mentionCandidates.map((agent, index) => (
                    <MentionItem
                      key={agent.id}
                      agent={agent}
                      index={index}
                      active={index === mentionIndex}
                      presence={presenceStatus(statuses[agent.id]?.state, agent.enabled)}
                      onPick={acceptMention}
                      onHover={setMentionIndex}
                    />
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          )}
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Hosted realtime voice on the DM surface — the SAME VoiceModal the chat
// composer uses, pointed at the resident's own serve. `ensureSession` wakes
// the agent and returns its uiUrl; UiConfigProvider derives /ws/realtime and
// the auth token from it, exactly as OmniAgentsApp does for the Session tab.
// The voice conversation is with the same agent (same spec, same tools) and
// its transcript lands in the resident's session history.
// ---------------------------------------------------------------------------

function ResidentHostedVoice({
  agentId,
  onClose,
  onError,
}: {
  agentId: string;
  onClose: () => void;
  onError: (message: string) => void;
}): React.JSX.Element | null {
  const [connection, setConnection] = useState<AgentRuntimeConnection | null>(null);

  useEffect(() => {
    let cancelled = false;
    residentApi
      .ensureSession(agentId)
      .then(({ connection: nextConnection }) => {
        if (!cancelled) {
          setConnection({
            ...nextConnection,
            baseUrl: new URL(nextConnection.baseUrl, serverOrigin()).toString(),
          });
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          onError(`Voice unavailable: ${err.message}`);
          onClose();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, onClose, onError]);

  if (!connection) {
    return null; // waking the agent; the modal appears once its serve is up
  }
  return (
    <UiConfigProvider connection={connection}>
      <VoiceModal isOpen onClose={onClose} />
    </UiConfigProvider>
  );
}

// ---------------------------------------------------------------------------
// Live session view — the REAL session UI (same OmniAgentsApp every chat/code
// column renders), mounted on the agent's process. Talking to an agent IS its
// session: full transcript, tool activity, approvals, input.
// ---------------------------------------------------------------------------

function ResidentSessionView({ agent }: { agent: ResidentAgent }): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);
  const [boot, setBoot] = useState<
    | { phase: 'booting' }
    | { phase: 'ready'; connection: AgentRuntimeConnection; sessionId: string }
    | { phase: 'parked' }
    | { phase: 'error'; message: string }
  >({ phase: 'booting' });
  const runtimeState = useStore($residentStatus)[agent.id]?.state;

  // Speech client tools are fulfilled by main's watcher — the SINGLE
  // fulfiller. `client_request` broadcasts to every attached channel, and
  // an App without a handler nacks with "No client tool handler
  // registered", racing the watcher's real answer. This handler swallows
  // the request (never resolves) so this view never responds at all.
  const swallowToolCall = useCallback(
    () => new Promise<{ ok: boolean }>(() => {}) as Promise<{ ok: boolean; result?: Record<string, unknown> }>,
    []
  );

  const launch = useCallback(() => {
    setBoot({ phase: 'booting' });
    residentApi
      .ensureSession(agent.id)
      .then(({ sessionId, connection }) => setBoot({ phase: 'ready', connection, sessionId }))
      .catch((err: Error) => setBoot({ phase: 'error', message: err.message }));
  }, [agent.id]);

  useEffect(() => {
    launch();
  }, [launch]);

  // Idle-park can fire while this view is mounted (the park timer re-arms on
  // every run end): the process stops and the mounted App's WS dies. Swap the
  // dead embedded client for an explicit parked state instead of leaving a corpse —
  // auto-relaunching here would keep the agent awake forever, defeating parking.
  useEffect(() => {
    if (boot.phase === 'ready' && runtimeState === 'parked') {
      setBoot({ phase: 'parked' });
    }
  }, [boot.phase, runtimeState]);

  const themedConnection = useMemo(() => {
    if (boot.phase !== 'ready') {
      return null;
    }
    const url = new URL(boot.connection.baseUrl, serverOrigin());
    const theme = storeData.theme ?? 'teams-light';
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return { ...boot.connection, baseUrl: url.toString() };
  }, [boot, storeData.theme]);

  if (boot.phase === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-center p-8">
        <span>{boot.message}</span>
        <Button size="sm" onClick={launch}>
          Retry
        </Button>
      </div>
    );
  }
  if (boot.phase === 'parked') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-center p-8">
        <span>{agent.name} parked after sitting idle.</span>
        <Button size="sm" onClick={launch}>
          Wake
        </Button>
      </div>
    );
  }
  if (boot.phase !== 'ready' || !themedConnection) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-center p-8">
        <Spinner />
        <span>Opening session…</span>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      <OmniAgentsApp connection={themedConnection} sessionId={boot.sessionId} onClientToolCall={swallowToolCall} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel membership bar (per-channel feed header)
// ---------------------------------------------------------------------------

/** A member chip carries the agent's live state and opens its session —
 *  presence and click-through, not a membership toggle (that lives in the
 *  manage menu, a deliberate action). */
const MemberChip = memo(function MemberChip({
  agent,
  runtime,
  onOpen,
}: {
  agent: ResidentAgent;
  runtime: ResidentAgentRuntime | undefined;
  onOpen: (agentId: string) => void;
}): React.JSX.Element {
  const handleClick = useCallback(() => onOpen(agent.id), [onOpen, agent.id]);
  const state = runtime?.state;
  const busy = state === 'thinking' || state === 'reflecting' || state === 'starting';
  // While busy the tooltip carries the wake reason — a one-line headline of
  // what the agent is on, without opening its session.
  const headline = busy && runtime?.lastReason ? ` · ${runtime.lastReason}` : '';
  const presence = presenceStatus(state, agent.enabled);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="rounded-full p-0.5 pr-2 font-normal"
          onClick={handleClick}
          // The button's own label wins over everything in its subtree, so the
          // avatar's off-screen status never reaches AT here — the label has
          // to carry presence itself. It quotes the badge, not STATE_LABEL: a
          // disabled agent reads `offline` while its runtime still says idle.
          aria-label={`Open ${agent.name}'s session — ${PRESENCE_LABEL[presence]}`}
        >
          <AgentAvatar name={agent.name} colorId={agent.id} size={20} presence={presence} />
          {agent.name}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`Open ${agent.name}'s session — ${STATE_LABEL[state ?? 'parked']}${headline}`}</TooltipContent>
    </Tooltip>
  );
});

function MemberBar({
  channel,
  roster,
  onOpenAgent,
}: {
  channel: string;
  roster: ResidentAgent[];
  onOpenAgent: (agentId: string) => void;
}): React.JSX.Element | null {
  const storeData = useStore(persistedStoreApi.$atom);
  const statuses = useStore($residentStatus);
  const def = (storeData.residentChannelDefs ?? []).find((c) => c.id === channel);
  // Absent member list = open channel: every agent (incl. future ones) is in.
  const isOpenChannel = !def?.members;
  const memberIds = useMemo(() => def?.members ?? roster.map((a) => a.id), [def?.members, roster]);
  const members = useMemo(() => roster.filter((a) => memberIds.includes(a.id)), [roster, memberIds]);

  const handleMemberChange = useCallback(
    (agentId: string, checked: boolean) => {
      const next = checked ? [...memberIds, agentId] : memberIds.filter((id) => id !== agentId);
      void residentApi.setChannelMembers(channel, next);
    },
    [channel, memberIds]
  );

  // The way back from a curated list: null clears `members`, restoring the
  // open state (agents created later join automatically).
  const handleOpenToEveryone = useCallback(() => {
    void residentApi.setChannelMembers(channel, null);
  }, [channel]);

  if (channel === TEAM_CHANNEL || dmParticipants(channel)) {
    return null; // #team is all-hands, always; DM participants are fixed
  }
  return (
    <div className="flex flex-col gap-0.5 px-5 py-2 border-b border-border">
      <div className="flex items-center flex-wrap gap-2">
        <span className="text-xs text-muted-foreground">Members:</span>
        {members.map((agent) => (
          <MemberChip key={agent.id} agent={agent} runtime={statuses[agent.id]} onOpen={onOpenAgent} />
        ))}
        {roster.length === 0 && <span className="text-xs text-muted-foreground">no agents yet</span>}
        {roster.length > 0 && members.length === 0 && (
          <span className={cn('text-xs text-muted-foreground', 'text-warning')}>
            No members — posts here wake no agents
          </span>
        )}
        <div className="flex-1" />
        {isOpenChannel && roster.length > 0 && <span className="text-xs text-muted-foreground">Open to all</span>}
        {roster.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Manage members">
                <UserPlus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={isOpenChannel} onClick={handleOpenToEveryone}>
                {isOpenChannel ? <Check /> : null}
                Everyone (default)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {roster.map((agent) => (
                <DropdownMenuCheckboxItem
                  key={agent.id}
                  checked={memberIds.includes(agent.id)}
                  onCheckedChange={(checked) => handleMemberChange(agent.id, checked)}
                >
                  {agent.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
        Posts reach members on their next wakeup — mention an agent by name to wake it now.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DM preview row (Conversations tab)
// ---------------------------------------------------------------------------

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

/** One agent identity inside a DM row: who it is, plus its live presence. */
type DmAvatar = { name: string; colorId: string; presence?: AgentPresence };

/** A DM thread row: the peer's identity (avatar + presence), last-message
 *  snippet, time. This is the Conversations tab's browse row — sidebar DMs
 *  are nav rows (`DmNavRow`). The multi-avatar branch is the component's
 *  declared contract but currently unreachable: the one call site renders an
 *  agent's own Conversations tab, which always names a single counterparty. */
const DmRow = memo(function DmRow({
  channelId,
  title,
  avatars,
  snippet,
  lastAt,
  unread,
  onSelect,
}: {
  channelId: string;
  title: string;
  /** Identity of each thread participant that is an agent — one for a
   *  user↔agent thread, two for agent↔agent — each with its live presence. */ avatars: ReadonlyArray<DmAvatar>;
  snippet: string;
  lastAt: number;
  unread: number;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  const single = avatars.length === 1 ? avatars[0] : null;
  return (
    <Item asChild variant="outline" size="sm">
      <button
        type="button"
        className="w-full min-w-0 cursor-pointer text-left hover:bg-accent/50"
        onClick={handleClick}
      >
        <ItemMedia>
          {single ? (
            <AgentAvatar
              name={single.name}
              colorId={single.colorId}
              size={32}
              {...(single.presence ? { presence: single.presence } : {})}
            />
          ) : (
            <AgentAvatarGroup avatars={avatars} size={24} />
          )}
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className={cn('max-w-full', unread > 0 && 'font-semibold')}>
            <span className="truncate">{title}</span>
          </ItemTitle>
          <ItemDescription className="line-clamp-2 max-w-full text-left wrap-anywhere">{snippet}</ItemDescription>
        </ItemContent>
        <ItemActions className="ml-auto shrink-0 self-start">
          <span className="text-xs whitespace-nowrap text-muted-foreground">{formatTimestamp(lastAt)}</span>
          {unread > 0 && (
            <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-xs tabular-nums">
              {unread}
            </Badge>
          )}
        </ItemActions>
      </button>
    </Item>
  );
});

// ---------------------------------------------------------------------------
// Roster: the agent directory (the Slack "People" shape). Agents are not
// sidebar rows — one nav row opens this browse surface, where the richer
// metadata (role, scope, last wake) and row actions belong.
// ---------------------------------------------------------------------------

const AgentRow = memo(function AgentRow({
  agent,
  runtime,
  projectLabel,
  onSelect,
  onMessage,
  onWake,
  onToggleEnabled,
  onRequestDelete,
}: {
  agent: ResidentAgent;
  runtime: ResidentAgentRuntime | undefined;
  projectLabel: string | null;
  onSelect: (id: string) => void;
  onMessage: (id: string) => void;
  onWake: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRequestDelete: (id: string) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const handleClick = useCallback(() => onSelect(agent.id), [onSelect, agent.id]);
  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onSelect(agent.id);
      }
    },
    [onSelect, agent.id]
  );
  const handleMenuOpenChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const handleMessage = useCallback(() => onMessage(agent.id), [onMessage, agent.id]);
  const handleWake = useCallback(() => onWake(agent.id), [onWake, agent.id]);
  const handleToggle = useCallback(
    () => onToggleEnabled(agent.id, !agent.enabled),
    [onToggleEnabled, agent.id, agent.enabled]
  );
  const handleDelete = useCallback(() => onRequestDelete(agent.id), [onRequestDelete, agent.id]);
  const state = runtime?.state;
  // Presence carries idle/parked; a text badge appears only while a turn is
  // actually running (the state worth reading), or when disabled.
  const busy = state === 'thinking' || state === 'reflecting' || state === 'starting';
  return (
    // div+role rather than <button>: the row hosts the "…" menu button, and
    // nesting buttons inside a button is invalid markup.
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col items-stretch gap-0.5 pl-5 pr-2 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2 [&:hover_.resident-row-menu]:opacity-100 [&:focus-within_.resident-row-menu]:opacity-100"
      onClick={handleClick}
      onKeyDown={handleRowKeyDown}
    >
      <span className="flex items-center gap-2">
        <AgentAvatar name={agent.name} colorId={agent.id} size={32} presence={presenceStatus(state, agent.enabled)} />
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-center gap-2 font-normal text-sm min-w-0">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{agent.name}</span>
            {busy && <Badge variant="secondary">{STATE_LABEL[state ?? 'parked']}</Badge>}
            {!agent.enabled && <Badge variant="secondary">Disabled</Badge>}
          </span>
          <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
            {agent.role}
            {projectLabel ? ` · ${projectLabel}` : ''}
            {runtime?.lastWakeupAt ? ` · woke ${formatTimestamp(runtime.lastWakeupAt)}` : ''}
          </span>
        </span>
        <span
          role="presentation"
          className={cn(
            'flex items-center gap-0.5 shrink-0 opacity-0 transition-opacity duration-100 [@media(hover:none)]:opacity-100',
            'resident-row-menu',
            menuOpen && 'opacity-100'
          )}
          onClick={stopPropagation}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-primary"
                aria-label={`Message ${agent.name}`}
                onClick={handleMessage}
              >
                <MessageCircle />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Message</TooltipContent>
          </Tooltip>
          <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`${agent.name} actions`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleMessage}>
                <MessageCircle />
                Message
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!agent.enabled} onClick={handleWake}>
                <Zap />
                Wake now
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleToggle}>{agent.enabled ? 'Disable' : 'Enable'}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={handleDelete}>
                <Trash2 />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </span>
    </div>
  );
});

function AgentRoster({
  roster,
  projects,
  onOpenAgent,
  onMessage,
  onWake,
  onToggleEnabled,
  onRequestDelete,
  onNewAgent,
  onOpenHandbook,
}: {
  roster: ResidentAgent[];
  projects: Project[];
  onOpenAgent: (id: string) => void;
  onMessage: (id: string) => void;
  onWake: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRequestDelete: (id: string) => void;
  onNewAgent: () => void;
  onOpenHandbook: () => void;
}): React.JSX.Element {
  const isDesktop = useIsDesktop();
  const statuses = useStore($residentStatus);
  return (
    <>
      {/* Mobile titles via the TopAppBar; the band then only carries the
            action. */}
      <div className="flex flex-col gap-1 pl-5 pr-5 pt-5 pb-2 shrink-0">
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
          {isDesktop && (
            <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
              Agents
            </span>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onOpenHandbook}>
            <BookOpen />
            Handbook
          </Button>
          <Button size="sm" onClick={onNewAgent}>
            <Plus />
            New agent
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          Your AI teammates. Message one privately, or work together in a shared channel.
        </span>
      </div>
      {roster.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-base">No agents yet</EmptyTitle>
            <EmptyDescription>
              Resident agents are named, persistent teammates: they wake on messages and mentions, work in their own
              sandbox, talk in #team, and distill each day into durable memory.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onNewAgent}>
              <Plus />
              New agent
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="w-full max-w-4xl ml-auto mr-auto px-4 pt-3 pb-6">
            {roster.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                runtime={statuses[agent.id]}
                projectLabel={
                  (agent.projectIds ?? [])
                    .map((id) => projects.find((p) => p.id === id)?.label)
                    .filter(Boolean)
                    .join(', ') || null
                }
                onSelect={onOpenAgent}
                onMessage={onMessage}
                onWake={onWake}
                onToggleEnabled={onToggleEnabled}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Assignment fields (shared by settings + create form)
// ---------------------------------------------------------------------------

/** Order-insensitive id-set equality, for the scope dirty check. */
function sameIdSet(a: string[], b: string[]): boolean {
  const setB = new Set(b);
  return a.length === setB.size && a.every((id) => setB.has(id));
}

const ProjectScopeRow = memo(
  ({ project, checked, onToggle }: { project: Project; checked: boolean; onToggle: (id: string) => void }) => {
    const handleChange = useCallback(() => onToggle(project.id), [onToggle, project.id]);
    return (
      <label className="inline-flex items-center gap-2 text-sm">
        <Checkbox checked={checked} onCheckedChange={handleChange} />
        {project.label}
      </label>
    );
  }
);
ProjectScopeRow.displayName = 'ProjectScopeRow';

function AssignmentFields({
  projectIds,
  profileName,
  projects,
  sandboxContext,
  onProjectIdsChange,
  onProfileChange,
  showProjects = true,
  showSandbox = true,
}: {
  projectIds: string[];
  profileName: string;
  projects: Project[];
  sandboxContext: SandboxContext;
  onProjectIdsChange: (projectIds: string[]) => void;
  onProfileChange: (profileName: string) => void;
  showProjects?: boolean;
  showSandbox?: boolean;
}): React.JSX.Element {
  const handleToggle = useCallback(
    (id: string) => {
      onProjectIdsChange(projectIds.includes(id) ? projectIds.filter((p) => p !== id) : [...projectIds, id]);
    },
    [onProjectIdsChange, projectIds]
  );
  return (
    <>
      {showProjects && (
        <Field>
          <FieldLabel>
            {infoLabel(
              'Projects',
              "Scoped agents launch with every selected project's sources mounted (with their git credentials); their private home rides along as the `home` mount. None = generalist with only the home workspace."
            )}
          </FieldLabel>
          <div className="flex flex-col">
            {projects.map((p) => (
              <ProjectScopeRow key={p.id} project={p} checked={projectIds.includes(p.id)} onToggle={handleToggle} />
            ))}
          </div>
        </Field>
      )}
      {showSandbox && (
        <Field>
          <FieldLabel>
            {infoLabel(
              'Sandbox',
              "Where this agent's sessions run. Applied on save — the agent parks and its next wakeup starts with the new configuration."
            )}
          </FieldLabel>
          <SandboxPicker value={profileName} onChange={onProfileChange} context={sandboxContext} />
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings tab (edit form with explicit save + error surfacing)
// ---------------------------------------------------------------------------

function AgentSettings({
  agent,
  projects,
  sandboxContext,
  section = 'profile',
  embedded = false,
}: {
  agent: ResidentAgent;
  projects: Project[];
  sandboxContext: SandboxContext;
  section?: 'profile' | 'advanced';
  embedded?: boolean;
}): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);

  // Saved baselines — the whole form commits together on Save (one commit
  // model; no field auto-saves behind the user's back).
  const savedProjectIds = agent.projectIds ?? [];
  const savedProfileName = agent.profileName ?? storeData.defaultProfileName ?? 'devbox';
  const savedMorningHour = agent.morningHour;

  const savedSuperuser = agent.superuser ?? false;

  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [persona, setPersona] = useState(agent.personaText);
  const [projectIds, setProjectIds] = useState<string[]>(savedProjectIds);
  const [profileName, setProfileName] = useState(savedProfileName);
  const [morningHour, setMorningHour] = useState<number | null>(savedMorningHour);
  const [superuser, setSuperuser] = useState(savedSuperuser);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setPersona(agent.personaText);
    setProjectIds(agent.projectIds ?? []);
    setProfileName(agent.profileName ?? persistedStoreApi.$atom.get().defaultProfileName ?? 'devbox');
    setMorningHour(agent.morningHour);
    setSuperuser(agent.superuser ?? false);
    setError(null);
    // Only re-seed the form when a DIFFERENT agent is opened — not when a
    // background store update lands mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const scopeDirty = !sameIdSet(projectIds, savedProjectIds);
  const dirty =
    name !== agent.name ||
    role !== agent.role ||
    persona !== agent.personaText ||
    scopeDirty ||
    profileName !== savedProfileName ||
    morningHour !== savedMorningHour ||
    superuser !== savedSuperuser;

  const handleName = useCallback((e: ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);
  const handleRole = useCallback((e: ChangeEvent<HTMLInputElement>) => setRole(e.target.value), []);
  const handlePersona = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => setPersona(e.target.value), []);
  const handleMorningHour = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setMorningHour(e.currentTarget.value === 'off' ? null : Number(e.currentTarget.value));
  }, []);

  const handleSuperuser = useCallback((_: unknown, data: { checked: boolean }) => {
    setSuperuser(data.checked);
  }, []);

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    residentApi
      .update(agent.id, {
        name,
        role,
        personaText: persona,
        // Assignment fields only when actually changed — an untouched
        // inherited default must not be pinned as an explicit choice.
        ...(scopeDirty ? { projectIds } : {}),
        ...(profileName !== savedProfileName ? { profileName } : {}),
        ...(morningHour !== savedMorningHour ? { morningHour } : {}),
        ...(superuser !== savedSuperuser ? { superuser } : {}),
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, [
    agent.id,
    name,
    role,
    persona,
    projectIds,
    scopeDirty,
    profileName,
    savedProfileName,
    morningHour,
    savedMorningHour,
    superuser,
    savedSuperuser,
  ]);

  return (
    <div className={embedded ? undefined : 'flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4'}>
      <div className="flex flex-col gap-4 w-full max-w-2xl ml-auto mr-auto">
        {section === 'profile' && (
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onChange={handleName} />
            <FieldDescription>
              {`DM address: @${residentHandle(name.trim() || agent.name)} — it follows the name.`}
            </FieldDescription>
          </Field>
        )}
        {section === 'profile' && (
          <Field>
            <FieldLabel>Role</FieldLabel>
            <Input value={role} onChange={handleRole} />
          </Field>
        )}
        {section === 'profile' && (
          <Field>
            <FieldLabel>Persona</FieldLabel>
            <Textarea value={persona} rows={8} onChange={handlePersona} />
            <FieldDescription>
              Who this agent is — voice, doctrine, specialization. Applied on its next session start.
            </FieldDescription>
          </Field>
        )}
        <AssignmentFields
          projectIds={projectIds}
          profileName={profileName}
          projects={projects}
          sandboxContext={sandboxContext}
          onProjectIdsChange={setProjectIds}
          onProfileChange={setProfileName}
          showProjects={section === 'profile'}
          showSandbox={section === 'advanced'}
        />

        {section === 'profile' && (
          <Field>
            <FieldLabel>
              {infoLabel(
                'Morning wakeup',
                'The daily planning beat — the agent wakes with its memories and the overnight digest. If the app is closed at that hour, the beat catches up (marked late) when the app next opens that day.'
              )}
            </FieldLabel>
            <Select value={morningHour === null ? 'off' : String(morningHour)} onChange={handleMorningHour}>
              <option value="off">Off — no morning beat</option>
              {MORNING_HOUR_OPTIONS.map((h) => (
                <option key={h} value={String(h)}>
                  {`${h}:00`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {section === 'advanced' && (
          <Field>
            <FieldLabel>
              {infoLabel(
                'Workspace superuser',
                'Grants tools over your whole deck: see every column (list_workspace), instruct and approve other agents (column_send / column_decide), open and close columns, and drive any column’s apps. The tools work while the app is open; when it’s closed they return an error the agent understands. The global voice hotkey targets the first enabled superuser’s DM.'
              )}
            </FieldLabel>
            <label className="inline-flex items-center gap-2 text-sm">
              <Switch checked={superuser} onCheckedChange={(checked) => handleSuperuser(undefined, { checked })} />
              Can observe and drive the workspace
            </label>
          </Field>
        )}

        <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab (durable memory editor)
// ---------------------------------------------------------------------------

function AgentMemory({ agent, onBack }: { agent: ResidentAgent; onBack?: () => void }): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);
  const memories = useMemo(
    () => (storeData.residentMemories ?? {})[agent.id] ?? [],
    [storeData.residentMemories, agent.id]
  );
  const [newMemory, setNewMemory] = useState('');
  const [newKey, setNewKey] = useState('');

  const forgetMemory = useCallback(
    (key: string) => {
      void residentApi.setMemories(
        agent.id,
        memories.filter((m) => m.key !== key)
      );
    },
    [agent.id, memories]
  );

  const handleNewMemory = useCallback((e: ChangeEvent<HTMLInputElement>) => setNewMemory(e.target.value), []);
  const handleNewKey = useCallback((e: ChangeEvent<HTMLInputElement>) => setNewKey(e.target.value), []);
  const addMemory = useCallback(() => {
    const text = newMemory.trim();
    if (!text) {
      return;
    }
    setNewMemory('');
    setNewKey('');
    // Explicit key wins (normalized; same key = update in place, mirroring the
    // agent's remember tool). Absent, derive from the leading words and
    // suffix on collision.
    const explicit = memoryKey(newKey);
    if (explicit && memories.some((m) => m.key === explicit)) {
      void residentApi.setMemories(
        agent.id,
        memories.map((m) => (m.key === explicit ? { key: explicit, text, at: Date.now() } : m))
      );
      return;
    }
    const base = explicit || memoryKey(text.split(/\s+/).slice(0, 5).join(' ')) || 'memory';
    let key = base;
    for (let n = 2; memories.some((m) => m.key === key); n++) {
      key = `${base}-${n}`;
    }
    void residentApi.setMemories(agent.id, [...memories, { key, text, at: Date.now() }]);
  }, [agent.id, memories, newMemory, newKey]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="w-full max-w-4xl ml-auto mr-auto flex flex-col gap-4">
        {onBack && (
          <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
            Back to Advanced
          </Button>
        )}
        <div className="flex flex-col gap-4 w-full max-w-2xl ml-auto mr-auto">
          <Field>
            <FieldLabel>
              {infoLabel(
                `Durable memory (${memories.length})`,
                'Keyed facts the agent maintains with its remember/forget tools (curated nightly at reflection); you can prune or add here. Changes reach the agent on its next run.'
              )}
            </FieldLabel>
            <div>
              {memories.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  Nothing remembered yet. The agent saves facts with its remember tool as it works.
                </span>
              )}
              {memories.map((m) => (
                <MemoryRow key={m.key} memoryKey={m.key} text={m.text} onForget={forgetMemory} />
              ))}
              <div className="flex gap-2 mt-2">
                <Input value={newKey} placeholder="key (optional)" onChange={handleNewKey} />
                <Input
                  className="flex-1"
                  value={newMemory}
                  placeholder="Add a fact the agent should always carry…"
                  onChange={handleNewMemory}
                />

                <Button size="sm" onClick={addMemory} disabled={!newMemory.trim()}>
                  {memoryKey(newKey) && memories.some((m) => m.key === memoryKey(newKey)) ? 'Update' : 'Add'}
                </Button>
              </div>
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

const MemoryRow = memo(function MemoryRow({
  memoryKey: key,
  text,
  onForget,
}: {
  memoryKey: string;
  text: string;
  onForget: (key: string) => void;
}): React.JSX.Element {
  const handleForget = useCallback(() => onForget(key), [onForget, key]);
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground font-mono text-xs">{key}</span>
      <span className="flex-1 text-xs">{text}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forget memory" onClick={handleForget}>
        <Trash2 />
      </Button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Conversations tab (the agent's DM threads)
// ---------------------------------------------------------------------------

/**
 * Every DM thread this agent is in — with you or with other agents — newest
 * first. The sidebar's DM section only lists YOUR threads (the Slack
 * contract); an agent's page is where its agent↔agent conversations are
 * browsed. Opening one navigates to the thread feed (away from the agent),
 * like the header's Message button.
 */
function AgentConversations({
  agent,
  roster,
  onOpenChannel,
}: {
  agent: ResidentAgent;
  roster: ResidentAgent[];
  onOpenChannel: (channelId: string) => void;
}): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);
  const statuses = useStore($residentStatus);

  // Latest message per DM thread containing this agent — the same reduction
  // the sidebar runs, scoped to one participant.
  const threads = useMemo(() => {
    const latest = new Map<string, ResidentChannelMessage>();
    for (const m of storeData.residentChannels ?? []) {
      if (dmParticipants(m.channel)?.includes(agent.id)) {
        latest.set(m.channel, m);
      }
    }
    return [...latest.entries()].map(([id, last]) => ({ id, last })).sort((a, b) => b.last.at - a.last.at);
  }, [storeData.residentChannels, agent.id]);

  const unreadIn = useMemo(() => {
    const seen = storeData.residentChannelSeen ?? {};
    const counts: Record<string, number> = {};
    for (const m of storeData.residentChannels ?? []) {
      if (m.id > (seen[m.channel] ?? 0)) {
        counts[m.channel] = (counts[m.channel] ?? 0) + 1;
      }
    }
    return counts;
  }, [storeData.residentChannels, storeData.residentChannelSeen]);

  if (threads.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-base">No conversations yet</EmptyTitle>
            <EmptyDescription>{`DMs ${agent.name} has — with you or with other agents — appear here.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="w-full max-w-4xl ml-auto mr-auto flex flex-col gap-4">
        <ItemGroup className="gap-2">
          {threads.map((t) => {
            // Rows read from this agent's perspective: the OTHER party names the
            // thread ("You" for your own thread, the peer agent otherwise).
            const pair = dmParticipants(t.id);
            const other = pair?.find((p) => p !== agent.id) ?? USER_PARTICIPANT;
            const peer = other === USER_PARTICIPANT ? null : roster.find((a) => a.id === other);
            const presence = participantPresence(other, roster, statuses);
            const otherName = other === USER_PARTICIPANT ? 'You' : (peer?.name ?? other);
            return (
              <DmRow
                key={t.id}
                channelId={t.id}
                title={otherName}
                avatars={[{ name: otherName, colorId: other, ...(presence ? { presence } : {}) }]}
                snippet={`${t.last.from === USER_PARTICIPANT ? 'You' : (t.last.fromName ?? t.last.from)}: ${t.last.text}`}
                lastAt={t.last.at}
                unread={unreadIn[t.id] ?? 0}
                onSelect={onOpenChannel}
              />
            );
          })}
        </ItemGroup>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent detail: human-readable overview first; internals live in Advanced.
// ---------------------------------------------------------------------------

function AgentOverview({
  agent,
  projects,
  runtime,
}: {
  agent: ResidentAgent;
  projects: Project[];
  runtime: ResidentAgentRuntime | undefined;
}): React.JSX.Element {
  const storeData = useStore(persistedStoreApi.$atom);
  const projectLabels = (agent.projectIds ?? [])
    .map((id) => projects.find((project) => project.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const latestMessage = useMemo(() => {
    const messages = storeData.residentChannels ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.from === agent.id) {
        return messages[index];
      }
    }
    return null;
  }, [agent.id, storeData.residentChannels]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="w-full max-w-4xl ml-auto mr-auto flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Role</CardTitle>
              <CardDescription>What {agent.name} helps with</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm leading-relaxed">{agent.role || 'No role has been added yet.'}</p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FolderKanban className="size-4 shrink-0" />
                <span className="min-w-0 truncate">
                  {projectLabels.length > 0 ? projectLabels.join(', ') : 'Available across projects'}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Availability</CardTitle>
              <CardDescription>{availabilityLabel(runtime, agent.enabled)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                {runtime?.lastWakeupAt
                  ? `Last active ${formatTimestamp(runtime.lastWakeupAt)}`
                  : 'No activity in this app session yet'}
              </p>
              {runtime?.pendingCount ? (
                <p className="text-muted-foreground">{`${runtime.pendingCount} item${runtime.pendingCount === 1 ? '' : 's'} waiting`}</p>
              ) : null}
            </CardContent>
          </Card>
          <Card className="md:col-span-full">
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>The latest visible update from this agent</CardDescription>
            </CardHeader>
            <CardContent>
              {latestMessage ? (
                <div className="space-y-2">
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed">{latestMessage.text}</p>
                  <p className="text-xs text-muted-foreground">{formatTimestamp(latestMessage.at)}</p>
                </div>
              ) : runtime?.lastReason ? (
                <p className="text-sm leading-relaxed">{runtime.lastReason}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Activity will appear here after {agent.name} sends an update.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AgentAdvanced({
  agent,
  projects,
  sandboxContext,
  onOpenMemory,
  onOpenSession,
}: {
  agent: ResidentAgent;
  projects: Project[];
  sandboxContext: SandboxContext;
  onOpenMemory: () => void;
  onOpenSession: () => void;
}): React.JSX.Element {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="w-full max-w-4xl ml-auto mr-auto flex flex-col gap-4">
        <Card className="mx-auto w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Technical access</CardTitle>
            <CardDescription>Controls that affect how and where this agent can operate.</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentSettings
              agent={agent}
              projects={projects}
              sandboxContext={sandboxContext}
              section="advanced"
              embedded
            />
          </CardContent>
        </Card>
        <ItemGroup className="mx-auto w-full max-w-2xl gap-2">
          <Item asChild variant="outline">
            <button type="button" className="w-full text-left hover:bg-accent/50" onClick={onOpenMemory}>
              <ItemMedia variant="icon">
                <Brain />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Durable memory</ItemTitle>
                <ItemDescription>Review or edit the facts this agent carries between sessions.</ItemDescription>
              </ItemContent>
              <ItemActions className="text-sm text-muted-foreground">Open</ItemActions>
            </button>
          </Item>
          <Item asChild variant="outline">
            <button type="button" className="w-full text-left hover:bg-accent/50" onClick={onOpenSession}>
              <ItemMedia variant="icon">
                <Terminal />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Runtime session</ItemTitle>
                <ItemDescription>Inspect the agent’s raw session for troubleshooting.</ItemDescription>
              </ItemContent>
              <ItemActions className="text-sm text-muted-foreground">Open</ItemActions>
            </button>
          </Item>
        </ItemGroup>
      </div>
    </div>
  );
}

type AgentDetailView = 'overview' | 'conversations' | 'settings' | 'advanced';
type AgentAdvancedView = 'menu' | 'memory' | 'session';

function AgentDetail({
  agent,
  roster,
  projects,
  sandboxContext,
  onMessage,
  onOpenChannel,
  onDeleted,
}: {
  agent: ResidentAgent;
  roster: ResidentAgent[];
  projects: Project[];
  sandboxContext: SandboxContext;
  onMessage: (agentId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const isDesktop = useIsDesktop();
  const statuses = useStore($residentStatus);
  const runtime = statuses[agent.id];
  const [tab, setTab] = useState<AgentDetailView>('overview');
  const [advancedView, setAdvancedView] = useState<AgentAdvancedView>('menu');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleTabSelect = useCallback((value: string) => {
    const next = value as AgentDetailView;
    setTab(next);
    if (next === 'advanced') {
      setAdvancedView('menu');
    }
  }, []);
  const handleOpenMemory = useCallback(() => setAdvancedView('memory'), []);
  const handleOpenSession = useCallback(() => setAdvancedView('session'), []);
  const handleBackToAdvanced = useCallback(() => setAdvancedView('menu'), []);

  const handleMessage = useCallback(() => onMessage(agent.id), [onMessage, agent.id]);

  const handleWake = useCallback(() => {
    void residentApi.wake(agent.id);
  }, [agent.id]);

  const handleToggleEnabled = useCallback(() => {
    void residentApi.update(agent.id, { enabled: !agent.enabled });
  }, [agent.enabled, agent.id]);

  const openConfirmDelete = useCallback(() => setConfirmDelete(true), []);
  const closeConfirmDelete = useCallback(() => setConfirmDelete(false), []);
  const handleDelete = useCallback(() => {
    setConfirmDelete(false);
    void residentApi.delete(agent.id).then(onDeleted);
  }, [agent.id, onDeleted]);

  return (
    <>
      {/* Header band — title + actions above a metadata caption, like every
            other detail page. Destructive delete lives in the overflow menu. */}
      <div className="flex flex-col gap-1 pl-5 pr-5 pt-5 pb-2 shrink-0">
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
          {isDesktop && (
            <>
              <AgentAvatar
                name={agent.name}
                colorId={agent.id}
                size={40}
                presence={presenceStatus(runtime?.state, agent.enabled)}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
                    {agent.name}
                  </span>
                  <Badge variant="secondary">{availabilityLabel(runtime, agent.enabled)}</Badge>
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {agent.role}
                  {runtime?.lastWakeupAt ? ` · Last active ${formatTimestamp(runtime.lastWakeupAt)}` : ''}
                </span>
              </div>
            </>
          )}
          {!isDesktop && <Badge variant="secondary">{availabilityLabel(runtime, agent.enabled)}</Badge>}
          <div className="flex-1" />
          <Button size="sm" onClick={handleMessage}>
            <MessageCircle />
            Message
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!agent.enabled} onClick={handleWake}>
                <Zap />
                Wake now
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleToggleEnabled}>
                {agent.enabled ? 'Make unavailable' : 'Make available'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={openConfirmDelete}>
                <Trash2 />
                Delete agent…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Tabs value={tab} onValueChange={handleTabSelect}>
          <PageTabsList>
            <PageTabsTrigger value="overview">Overview</PageTabsTrigger>
            <PageTabsTrigger value="conversations">Conversations</PageTabsTrigger>
            <PageTabsTrigger value="settings">Settings</PageTabsTrigger>
            <PageTabsTrigger value="advanced">Advanced</PageTabsTrigger>
          </PageTabsList>
        </Tabs>
      </div>
      {tab === 'overview' ? (
        <AgentOverview agent={agent} projects={projects} runtime={runtime} />
      ) : tab === 'conversations' ? (
        <AgentConversations agent={agent} roster={roster} onOpenChannel={onOpenChannel} />
      ) : tab === 'settings' ? (
        <AgentSettings agent={agent} projects={projects} sandboxContext={sandboxContext} />
      ) : advancedView === 'memory' ? (
        <AgentMemory agent={agent} onBack={handleBackToAdvanced} />
      ) : advancedView === 'session' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
            <Button variant="ghost" size="sm" onClick={handleBackToAdvanced}>
              Back to Advanced
            </Button>
            <span className="text-sm font-medium">Runtime session</span>
          </div>
          {agent.enabled ? (
            <ResidentSessionView agent={agent} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-center p-8">
              <span>{agent.name} is unavailable. Make it available to inspect its runtime session.</span>
            </div>
          )}
        </div>
      ) : (
        <AgentAdvanced
          agent={agent}
          projects={projects}
          sandboxContext={sandboxContext}
          onOpenMemory={handleOpenMemory}
          onOpenSession={handleOpenSession}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={(open) => !open && closeConfirmDelete()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete ${agent.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              The agent, its durable memories, and its DM threads are removed. Its workspace folder stays on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// New-agent form
// ---------------------------------------------------------------------------

function NewAgentForm({
  projects,
  sandboxContext,
  onCreated,
  onCancel,
}: {
  projects: Project[];
  sandboxContext: SandboxContext;
  onCreated: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [persona, setPersona] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  // Container by default — a headless wakeup-driven agent should not
  // silently inherit `host`.
  const [profileName, setProfileName] = useState('devbox');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleName = useCallback((e: ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);
  const handleRole = useCallback((e: ChangeEvent<HTMLInputElement>) => setRole(e.target.value), []);
  const handlePersona = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => setPersona(e.target.value), []);

  // A template is a PERSONA prefill — role + doctrine, nothing else. The
  // name is the user's to give (the @address follows it); everything a
  // template fills stays editable afterwards.
  const handleTemplate = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const template = RESIDENT_TEMPLATES.find((t) => t.id === e.target.value);
    setTemplateId(template ? template.id : null);
    if (template) {
      setRole(template.role);
      setPersona(template.personaText);
    }
  }, []);

  const handleCreate = useCallback(() => {
    setCreating(true);
    setError(null);
    residentApi
      .create({ name, role, personaText: persona, profileName, ...(projectIds.length > 0 ? { projectIds } : {}) })
      .then((agent) => onCreated(agent.id))
      .catch((err: Error) => {
        setError(err.message);
        setCreating(false);
      });
  }, [name, role, persona, profileName, projectIds, onCreated]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="flex flex-col gap-4 w-full max-w-2xl ml-auto mr-auto">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} placeholder="Scout" onChange={handleName} />
          {name.trim() && (
            <FieldDescription>{`DM address: @${residentHandle(name)} — it follows the name`}</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel>Role</FieldLabel>
          <Input value={role} placeholder="research & codebase reconnaissance" onChange={handleRole} />
          <FieldDescription>One line — what this agent is for.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Persona</FieldLabel>
          <div className="flex flex-col gap-1">
            <Select value={templateId ?? ''} onChange={handleTemplate} aria-label="Persona template">
              <option value="">Template: start blank</option>
              {RESIDENT_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label} — {template.tagline}
                </option>
              ))}
            </Select>
            <Textarea value={persona} rows={10} onChange={handlePersona} />
          </div>
          <FieldDescription>
            Voice, doctrine, working style. Durable memory accumulates on top of this.
          </FieldDescription>
        </Field>
        <AssignmentFields
          projectIds={projectIds}
          profileName={profileName}
          projects={projects}
          sandboxContext={sandboxContext}
          onProjectIdsChange={setProjectIds}
          onProfileChange={setProfileName}
        />

        <div className="flex items-center gap-4 flex-wrap">
          <Button variant="default" onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? 'Creating…' : 'Create agent'}
          </Button>
          <Button onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handbook — the roster's ONE shared rules document (handbook-first)
// ---------------------------------------------------------------------------

/** The same Yoopta editor the project Docs pages mount (lazy, like PageView). */
const ContextEditor = lazy(() =>
  import('@/renderer/features/Tickets/ContextEditor').then((m) => ({ default: m.ContextEditor }))
);

const HANDBOOK_SAVE_DEBOUNCE_MS = 800;

function HandbookPane({ roster }: { roster: ResidentAgent[] }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ body: string } | null>(null);
  const [meta, setMeta] = useState<{ updatedAt: number; updatedBy: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    residentApi
      .getHandbook()
      .then((h) => {
        if (!cancelled) {
          setLoaded({ body: h?.body ?? '' });
          setMeta(h ? { updatedAt: h.updatedAt, updatedBy: h.updatedBy } : null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pages-style debounced autosave; the pending edit flushes on unmount so
  // navigating away never drops the last keystrokes.
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const body = pendingRef.current;
    if (body === null) {
      return;
    }
    pendingRef.current = null;
    residentApi
      .setHandbook(body)
      .then(() => setMeta({ updatedAt: Date.now(), updatedBy: null }))
      .catch((e: Error) => setError(e.message));
  }, []);
  const handleMarkdownChange = useCallback(
    (md: string) => {
      pendingRef.current = md;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(flush, HANDBOOK_SAVE_DEBOUNCE_MS);
    },
    [flush]
  );
  useEffect(() => flush, [flush]);

  const editorId = meta?.updatedBy ? parseResidentPrincipal(meta.updatedBy) : null;
  const editorName = meta?.updatedBy
    ? editorId
      ? (roster.find((a) => a.id === editorId)?.name ?? meta.updatedBy)
      : meta.updatedBy
    : 'you';

  if (!loaded) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pl-5 pr-5 max-w-4xl w-full ml-auto mr-auto">
        <div className="flex w-full flex-col gap-5 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className={`h-3 ${['w-15', 'w-18', 'w-20'][index % 3]}`} />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-col gap-1 pl-8 pr-8 pt-4">
        <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
          Handbook
        </span>
        {meta && (
          <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
            Last updated {formatTimestamp(meta.updatedAt)} by {editorName}
          </span>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pl-5 pr-5 max-w-4xl w-full ml-auto mr-auto">
        <Suspense
          fallback={
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-center p-8">
              <Spinner />
            </div>
          }
        >
          <ContextEditor initialMarkdown={loaded.body} onChangeMarkdown={handleMarkdownChange} />
        </Suspense>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function ResidentsTab(): React.JSX.Element {
  const isDesktop = useIsDesktop();
  const storeData = useStore(persistedStoreApi.$atom);
  const statuses = useStore($residentStatus);
  const view = useStore($residentsView);
  // The new-agent form lives in the view atom so the app sidebar can paint
  // the Agents row while it's open.
  const creating = view.showNewAgent === true;

  const roster: ResidentAgent[] = useMemo(() => storeData.residentAgents ?? [], [storeData.residentAgents]);
  const selected = roster.find((a) => a.id === view.selectedAgentId) ?? null;
  const projects = useMemo(() => storeData.projects ?? [], [storeData.projects]);

  const machines = useStore($machines);
  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter
      .invoke('platform:is-enterprise')
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);
  const sandboxContext: SandboxContext = {
    isEnterprise,
    available: storeData.availableSandboxProfiles,
    machines,
  };

  useEffect(() => {
    void syncResidentStatus();
  }, []);

  const channelDefs = useMemo(() => storeData.residentChannelDefs ?? [], [storeData.residentChannelDefs]);
  const channelIds = useMemo(() => [TEAM_CHANNEL, ...channelDefs.map((c) => c.id)], [channelDefs]);
  // DM threads are first-class rows, derived from the log (newest first),
  // carrying their last message for the row snippet.
  const dmThreads = useMemo(() => {
    const latest = new Map<string, ResidentChannelMessage>();
    for (const m of storeData.residentChannels ?? []) {
      if (m.channel.startsWith('dm:')) {
        latest.set(m.channel, m);
      }
    }
    return [...latest.entries()].map(([id, last]) => ({ id, at: last.at, last })).sort((a, b) => b.at - a.at);
  }, [storeData.residentChannels]);
  const dmTitle = useCallback(
    (channelId: string): string => {
      const pair = dmParticipants(channelId);
      if (!pair) {
        return channelId;
      }
      const nameOf = (p: string): string =>
        p === USER_PARTICIPANT ? 'You' : (roster.find((a) => a.id === p)?.name ?? p);
      // Your own threads read as the peer's name (the Slack DM shape);
      // observed agent↔agent threads name both parties.
      if (pair.includes(USER_PARTICIPANT)) {
        return nameOf(pair.find((p) => p !== USER_PARTICIPANT) ?? pair[0]);
      }
      return `${nameOf(pair[0])} ↔ ${nameOf(pair[1])}`;
    },
    [roster]
  );
  // A DM channel is addressable when every participant still resolves —
  // including threads with NO messages yet (the start-a-DM path).
  const isKnownDm = useCallback(
    (ch: string): boolean => {
      const pair = dmParticipants(ch);
      return pair !== null && pair.every((p) => p === USER_PARTICIPANT || roster.some((a) => a.id === p));
    },
    [roster]
  );
  const selectedChannel =
    view.selectedChannel &&
    (channelIds.includes(view.selectedChannel) ||
      dmThreads.some((t) => t.id === view.selectedChannel) ||
      isKnownDm(view.selectedChannel))
      ? view.selectedChannel
      : null;
  // The user can post into their own DM threads; agent↔agent threads are
  // observed (the composer would misroute — post() targets one participant).
  const selectedDmPair = selectedChannel ? dmParticipants(selectedChannel) : null;
  const selectedIsAgentDm = selectedDmPair !== null && !selectedDmPair.includes(USER_PARTICIPANT);
  // Flags are mutually exclusive: every navigation replaces the whole atom.
  const handbookOpen = view.showHandbook === true;
  const rosterOpen = view.showRoster === true;
  const routinesOpen = view.showRoutines === true;
  const handleSelect = useCallback((id: string) => {
    $residentsView.set({ selectedAgentId: id, selectedChannel: null });
  }, []);

  const handleSelectChannel = useCallback((channelId: string) => {
    goToResidentChannel(channelId);
  }, []);

  // Start (or reopen) your DM thread with an agent — the thread is a valid
  // destination even before its first message.
  const handleMessageAgent = useCallback((agentId: string) => {
    goToResidentChannel(dmChannelId(USER_PARTICIPANT, agentId));
  }, []);

  const handleSelectHandbook = useCallback(() => {
    goToHandbook();
  }, []);

  // Row-menu agent actions (the same operations the detail header offers,
  // reachable without opening the agent — the Routines-row idiom).
  const handleWakeAgent = useCallback((id: string) => {
    void residentApi.wake(id);
  }, []);
  const handleToggleAgent = useCallback((id: string, enabled: boolean) => {
    void residentApi.update(id, { enabled });
  }, []);
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<ResidentAgent | null>(null);
  const handleRequestDeleteAgent = useCallback(
    (id: string) => setPendingDeleteAgent(roster.find((a) => a.id === id) ?? null),
    [roster]
  );
  const closeDeleteAgent = useCallback(() => setPendingDeleteAgent(null), []);
  const confirmDeleteAgent = useCallback(() => {
    const agent = pendingDeleteAgent;
    if (!agent) {
      return;
    }
    setPendingDeleteAgent(null);
    void residentApi.delete(agent.id);
    if ($residentsView.get().selectedAgentId === agent.id) {
      // Deleting the open agent lands back on the roster it came from.
      $residentsView.set({ selectedAgentId: null, selectedChannel: null, showRoster: true });
    }
  }, [pendingDeleteAgent]);

  const startCreate = useCallback(() => {
    goToNewAgent();
  }, []);
  const cancelCreate = useCallback(() => {
    // Cancel lands back on the roster the form opened from.
    goToRoster();
  }, []);
  const handleCreated = useCallback((id: string) => {
    $residentsView.set({ selectedAgentId: id, selectedChannel: null });
  }, []);
  const handleDeleted = useCallback(() => {
    // Deleting from the detail header lands back on the roster.
    goToRoster();
  }, []);
  // Mobile back for hierarchy-internal levels: an open agent or the create
  // form goes up to the roster. Surface roots show the drawer handle.
  const handleBackToRoster = useCallback(() => {
    goToRoster();
  }, []);

  /** Row identity for a DM thread: the agent participants' avatars, and the
   *  peer's live presence when it's a user↔agent thread. */
  const dmRowIdentity = useCallback(
    (channelId: string): { avatars: DmAvatar[] } => {
      const pair = dmParticipants(channelId);
      const agentIds = (pair ?? []).filter((p) => p !== USER_PARTICIPANT);
      // Every agent in the thread carries its own presence — an observed
      // agent↔agent row shows both, not just the first.
      const avatars: DmAvatar[] = agentIds.map((p) => ({
        name: roster.find((a) => a.id === p)?.name ?? p,
        colorId: p,
        ...(participantPresence(p, roster, statuses) ? { presence: participantPresence(p, roster, statuses) } : {}),
      }));
      if (avatars.length === 0) {
        avatars.push({ name: 'You', colorId: USER_PARTICIPANT });
      }
      return { avatars };
    },
    [roster, statuses]
  );

  // Desktop title band for a channel/DM feed — identity + context up top,
  // like every other detail page (mobile titles via the TopAppBar instead).
  let feedHeader: React.JSX.Element | null = null;
  if (selectedChannel && isDesktop) {
    if (selectedDmPair) {
      const identity = dmRowIdentity(selectedChannel);
      const single = identity.avatars.length === 1 ? identity.avatars[0] : null;
      feedHeader = (
        <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-2 border-b border-border shrink-0 min-w-0">
          {single ? (
            <AgentAvatar
              name={single.name}
              colorId={single.colorId}
              size={28}
              {...(single.presence ? { presence: single.presence } : {})}
            />
          ) : (
            <AgentAvatarGroup avatars={identity.avatars} size={24} />
          )}
          <span className="text-base font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
            {dmTitle(selectedChannel)}
          </span>
          {selectedIsAgentDm && (
            <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
              agent↔agent — observed
            </span>
          )}
        </div>
      );
    } else {
      const def = channelDefs.find((c) => c.id === selectedChannel);
      const headerMeta =
        def?.description ?? (selectedChannel === TEAM_CHANNEL ? 'All-hands — everyone reads it' : null);
      feedHeader = (
        <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-2 border-b border-border shrink-0 min-w-0">
          <span className="text-base font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
            #{selectedChannel}
          </span>
          {headerMeta && (
            <span className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
              {headerMeta}
            </span>
          )}
        </div>
      );
    }
  }

  const detailBody = creating ? (
    <>
      {isDesktop && (
        <div className="flex flex-col gap-1 pl-5 pr-5 pt-5 pb-2 shrink-0">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
            <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
              New agent
            </span>
          </div>
        </div>
      )}
      <NewAgentForm
        projects={projects}
        sandboxContext={sandboxContext}
        onCreated={handleCreated}
        onCancel={cancelCreate}
      />
    </>
  ) : selected ? (
    <AgentDetail
      agent={selected}
      roster={roster}
      projects={projects}
      sandboxContext={sandboxContext}
      onMessage={handleMessageAgent}
      onOpenChannel={handleSelectChannel}
      onDeleted={handleDeleted}
    />
  ) : handbookOpen ? (
    <HandbookPane roster={roster} />
  ) : routinesOpen ? (
    // The Routines surface owns its own master-detail (list + detail).
    <ScheduledTasks />
  ) : rosterOpen ? (
    <AgentRoster
      roster={roster}
      projects={projects}
      onOpenAgent={handleSelect}
      onMessage={handleMessageAgent}
      onWake={handleWakeAgent}
      onToggleEnabled={handleToggleAgent}
      onRequestDelete={handleRequestDeleteAgent}
      onNewAgent={startCreate}
      onOpenHandbook={handleSelectHandbook}
    />
  ) : roster.length === 0 && isDesktop ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle className="text-base">No agents yet</EmptyTitle>
        <EmptyDescription>
          Resident agents are named, persistent teammates: they wake on messages and mentions, work in their own
          sandbox, talk in #team, and distill each day into durable memory.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={startCreate}>
          <Plus />
          New agent
        </Button>
      </EmptyContent>
    </Empty>
  ) : selectedChannel ? (
    <>
      {feedHeader}
      <MemberBar channel={selectedChannel} roster={roster} onOpenAgent={handleSelect} />
      <ActivityFeed roster={roster} channel={selectedChannel} readOnly={selectedIsAgentDm} />
    </>
  ) : (
    <ActivityFeed roster={roster} onOpenChannel={handleSelectChannel} />
  );

  // Channel dialogs live inside ChannelsSection now — only the agent
  // delete confirm remains at shell level (roster rows + detail share it).
  const agentDialogs = (
    <AlertDialog open={pendingDeleteAgent !== null} onOpenChange={(open) => !open && closeDeleteAgent()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete ${pendingDeleteAgent?.name ?? ''}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The agent, its durable memories, and its DM threads are removed. Its workspace folder stays on disk.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmDeleteAgent}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // Mobile: the surface always fills the screen. A TopAppBar titles it and
  // leads with a back arrow at depth (agent detail / create form → roster)
  // or the drawer handle at a surface root. Routines titles itself at every
  // level (band header + internal bars).
  if (!isDesktop) {
    if (routinesOpen) {
      return (
        <div className="flex w-full h-full">
          <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden flex flex-col">
            <ScheduledTasks />
          </div>
          {agentDialogs}
        </div>
      );
    }
    const mobileTitle = creating
      ? 'New agent'
      : selected
        ? selected.name
        : selectedChannel
          ? selectedDmPair
            ? dmTitle(selectedChannel)
            : `#${selectedChannel}`
          : rosterOpen
            ? 'Agents'
            : handbookOpen
              ? 'Handbook'
              : 'Activity';
    const mobileBack = creating || selected !== null ? handleBackToRoster : undefined;
    return (
      <div className="flex w-full h-full">
        <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden flex flex-col">
          <TopAppBar title={mobileTitle} {...(mobileBack ? { onBack: mobileBack } : { showMenu: true })} />
          {detailBody}
        </div>
        {agentDialogs}
      </div>
    );
  }

  return (
    <div className="flex w-full h-full">
      <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden flex flex-col">{detailBody}</div>
      {agentDialogs}
    </div>
  );
}
