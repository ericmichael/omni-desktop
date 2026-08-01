import type { FieldProps, LabelProps } from '@fluentui/react-components';
import {
  Divider as LabeledDivider,
  Field,
  InfoLabel,
  InteractionTag,
  InteractionTagPrimary,
  makeStyles,
  mergeClasses,
  Spinner,
  Switch,
  Tab,
  TabList,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowReply20Regular,
  BookOpen20Regular,
  Chat20Regular,
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  FlashRegular,
  Mic20Regular,
  MoreHorizontal20Regular,
  PersonAdd20Regular,
  Send20Regular,
  Speaker220Regular,
  SpeakerMute20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { ChangeEvent, ComponentProps, FormEvent, KeyboardEvent } from 'react';
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
import { openMobileNav } from '@/renderer/app/mobile-nav';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import {
  Badge,
  Button,
  Caption1,
  Checkbox,
  ConfirmDialog,
  CounterBadge,
  EmptyState,
  FormSkeleton,
  IconButton,
  Input,
  Menu,
  type MenuCheckedValueChangeData,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  SaveBar,
  Select,
  Textarea,
  TopAppBar,
} from '@/renderer/ds';
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
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { Project, ResidentAgent, ResidentAgentRuntime, ResidentChannelMessage } from '@/shared/types';

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

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  listPane: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    '@media (min-width: 640px)': {
      // Nav-sidebar width — matches the Work sidebar's NavDrawer.
      width: '260px',
      flexShrink: 0,
      borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  listPaneGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  detailPane: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  detailPaneGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
    '&:hover .resident-row-menu': { opacity: 1 },
    '&:focus-within .resident-row-menu': { opacity: 1 },
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  /* Actions slot content on nav TreeItems (the Work sidebar's idiom). */
  rowActions: {
    display: 'flex',
    alignItems: 'center',
  },
  /* Hover/focus-revealed "…" menu on list rows — same idiom as Routines. */
  rowMenu: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  rowMenuOpen: {
    opacity: 1,
  },
  rowTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightRegular,
    fontSize: tokens.fontSizeBase300,
    minWidth: 0,
  },
  /* Unread rows follow the mainstream convention: weight, not just a badge. */
  rowTitleUnread: {
    fontWeight: tokens.fontWeightSemibold,
  },
  rowTitleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /* Two stacked text lines beside a row avatar. */
  rowLines: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  rowMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowTime: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
  /* ── Detail: the standard skeleton — full-bleed header band (title +
     actions + metadata), like the Routines and ticket detail pages. ── */
  bandHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  bandTitleRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  bandTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    color: tokens.colorNeutralForeground1,
  },
  bandSpacer: {
    flex: '1 1 0',
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  detailBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  sessionHost: {
    flex: '1 1 0',
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  sessionCenter: {
    flex: '1 1 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    padding: tokens.spacingHorizontalXXL,
  },
  feed: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
  },
  /* ── Message rows: the Slack gutter grid — avatar column, then head line
     over the body. Consecutive same-sender messages group: only the first
     carries the avatar + head. ── */
  message: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '32px 1fr',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    '&:hover .message-actions': { opacity: 1 },
    '&:focus-within .message-actions': { opacity: 1 },
  },
  messageGroupStart: {
    marginTop: tokens.spacingVerticalM,
  },
  /* Replies keep a narrower gutter under the thread rail. */
  messageReplyGrid: {
    gridTemplateColumns: '24px 1fr',
  },
  /* A reply nests under its root — one level deep, the Slack shape. */
  messageReply: {
    marginLeft: tokens.spacingHorizontalXL,
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `2px solid ${tokens.colorNeutralStroke1}`,
  },
  msgGutter: {
    paddingTop: '2px',
  },
  msgMain: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  messageHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  messageFrom: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  /* Hover action bar, floated over the row's top-right (Slack's idiom). */
  msgActions: {
    position: 'absolute',
    top: '-12px',
    right: tokens.spacingHorizontalS,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    '@media (hover: none)': { opacity: 1 },
  },
  /* Constrain the shared markdown surface to feed density. */
  markdownBody: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  /* Day dividers carry the date so message stamps stay time-only. */
  dayDivider: {
    flexShrink: 0,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  /* "↳ reply" marker for reply rows outside the grouped channel view. */
  replyMarker: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
  /* Conversation tag on Activity rows — a real button, so the tag can open
     the channel/thread it names. */
  channelBadgeBtn: {
    border: 'none',
    backgroundColor: 'transparent',
    padding: 0,
    cursor: 'pointer',
    display: 'inline-flex',
    borderRadius: tokens.borderRadiusMedium,
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '1px',
    },
  },
  /* "Show N earlier replies" — sits on the thread rail like the replies. */
  threadExpandBtn: {
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: '2px 0',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { color: tokens.colorBrandForeground1 },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '1px',
    },
  },
  /* Composer block: optional reply banner + error line + the input row.
     Relative so the mention popup can anchor above it. */
  composerArea: {
    position: 'relative',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  /* ── @-mention typeahead, floated above the composer. ── */
  mentionPopup: {
    position: 'absolute',
    bottom: '100%',
    left: tokens.spacingHorizontalL,
    zIndex: 10,
    minWidth: '260px',
    maxHeight: '240px',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  mentionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    border: 'none',
    backgroundColor: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase300,
  },
  mentionItemActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  mentionItemRole: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  replyBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
  },
  replyBannerText: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sendError: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalXS,
    color: tokens.colorPaletteRedForeground1,
  },
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalL,
  },
  composerInput: {
    flex: '1 1 0',
  },
  memoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  memoryText: {
    flex: '1 1 0',
    fontSize: tokens.fontSizeBase200,
  },
  memoryAdd: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  projectScopeList: {
    display: 'flex',
    flexDirection: 'column',
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
  newChannelHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  newChannelError: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    color: tokens.colorPaletteRedForeground1,
  },
  /* ── Channel member bar: member chips w/ live presence + manage menu. ── */
  memberBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  memberBarRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  memberBarSpacer: {
    flex: '1 1 0',
  },
  memberBarNote: {
    color: tokens.colorNeutralForeground3,
  },
  memberWarning: {
    color: tokens.colorPaletteYellowForeground1,
  },
  /* Desktop title band above a channel/DM feed (mobile titles via TopAppBar). */
  feedHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    minWidth: 0,
  },
  feedHeaderTitle: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  feedHeaderMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
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
  /* #system rows are the incident log — failures rise, chatter recedes. */
  messageIncident: {
    borderLeft: `3px solid ${tokens.colorStatusWarningBorder1}`,
    backgroundColor: tokens.colorStatusWarningBackground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  /* Agent↔agent DM threads render without a composer. */
  readOnlyHint: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  statusLine: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  idChip: {
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '560px',
  },
  /* ── Persona field: template select stacked over the doctrine text ── */
  personaField: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  /* ── Handbook: the Docs editor hosted at roster level ── */
  handbookPane: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minHeight: 0,
  },
  handbookHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingTop: tokens.spacingVerticalM,
  },
  handbookBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    maxWidth: '56rem',
    width: '100%',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
});

const MORNING_HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);

const STATE_LABEL: Record<ResidentAgentRuntime['state'], string> = {
  parked: 'Parked',
  starting: 'Starting…',
  idle: 'Idle',
  thinking: 'Thinking…',
  reflecting: 'Reflecting…',
};

const stateBadgeColor = (state: ResidentAgentRuntime['state'] | undefined): 'blue' | 'green' | 'default' => {
  if (state === 'thinking' || state === 'reflecting' || state === 'starting') {
    return 'blue';
  }
  if (state === 'idle') {
    return 'green';
  }
  return 'default';
};

/** Field label with the doctrine tucked behind an info icon — labels stay
 *  scannable, the manual stays available. */
const infoLabel = (text: string, info: string): FieldProps['label'] => ({
  children: (_: unknown, props: LabelProps) => (
    <InfoLabel {...props} info={info}>
      {text}
    </InfoLabel>
  ),
});

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
  /** Live presence — who you're about to address is worth knowing here. */
  presence?: AgentPresence;
  onPick: (agent: ResidentAgent) => void;
  onHover: (index: number) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onPick(agent);
    },
    [onPick, agent]
  );
  const handleMouseEnter = useCallback(() => onHover(index), [onHover, index]);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={mergeClasses(styles.mentionItem, active && styles.mentionItemActive)}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
    >
      <AgentAvatar name={agent.name} colorId={agent.id} size={24} {...(presence ? { presence } : {})} />
      <span>{agent.name}</span>
      <span className={styles.mentionItemRole}>{agent.role}</span>
    </button>
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
  /** Agent↔agent DM threads are observed, not joined — no composer. */
  readOnly?: boolean;
  /** All-traffic view only: makes each row's conversation tag a click
   *  target that opens the channel/thread it names. */
  onOpenChannel?: (channelId: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
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
      <div ref={feedRef} className={styles.feed} onScroll={handleFeedScroll}>
        {messages.length === 0 ? (
          channel ? (
            <EmptyState
              title={dmPair ? 'No messages in this thread yet' : `No messages in #${channel} yet`}
              description={
                dmPair
                  ? undefined
                  : 'Posts reach the channel’s members on their next wakeup; mention an agent by name to wake it now.'
              }
            />
          ) : (
            <EmptyState
              title="No activity yet"
              description="Everything your agents say — in #team and to each other — lands here. Posting mentions an agent by name to address it directly."
            />
          )
        ) : (
          feedItems.map((item) => {
            if (item.kind === 'day') {
              return (
                <LabeledDivider key={`day-${item.ts}`} className={styles.dayDivider}>
                  {formatDayLabel(item.ts)}
                </LabeledDivider>
              );
            }
            if (item.kind === 'expand') {
              return (
                <div key={`expand-${item.rootId}`} className={styles.messageReply}>
                  <button
                    type="button"
                    className={styles.threadExpandBtn}
                    onClick={handleExpandThread.bind(null, item.rootId)}
                  >
                    Show {item.hiddenCount} earlier {item.hiddenCount === 1 ? 'reply' : 'replies'}
                  </button>
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
                className={mergeClasses(
                  styles.message,
                  indent && styles.messageReplyGrid,
                  indent && styles.messageReply,
                  isIncident && styles.messageIncident,
                  groupHead && styles.messageGroupStart
                )}
              >
                <div className={styles.msgGutter}>
                  {groupHead && (
                    <AgentAvatar
                      name={m.from === USER_PARTICIPANT ? 'You' : fromName}
                      colorId={m.from}
                      size={indent ? 24 : 32}
                      {...(fromPresence ? { presence: fromPresence } : {})}
                    />
                  )}
                </div>
                <div className={styles.msgMain}>
                  {groupHead && (
                    <div className={styles.messageHead}>
                      <span className={styles.messageFrom}>{m.from === USER_PARTICIPANT ? 'You' : fromName}</span>
                      {/* Incident (#system) tags stay inert — `system` is a
                          reserved id with no channel view to open. */}
                      {label &&
                        (onOpenChannel && !isIncident ? (
                          <button
                            type="button"
                            className={styles.channelBadgeBtn}
                            aria-label={`Open ${label}`}
                            onClick={onOpenChannel.bind(null, m.channel)}
                          >
                            <Badge color="purple">{label}</Badge>
                          </button>
                        ) : (
                          <Badge color={isIncident ? 'yellow' : 'purple'}>{label}</Badge>
                        ))}
                      {showReplyMarker && (
                        <span className={styles.replyMarker} title={rootMsg ? rootMsg.text : undefined}>
                          ↳ replying to {rootMsg ? participantName(rootMsg) : 'an earlier message'}
                        </span>
                      )}
                      {replyCount !== undefined && (
                        <span className={styles.replyMarker}>
                          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                        </span>
                      )}
                      <Caption1>{isNamedChannel ? formatTimestamp(m.at) : formatTimeOfDay(m.at)}</Caption1>
                    </div>
                  )}
                  <MarkdownMessage content={m.text} className={styles.markdownBody} />
                </div>
                {isNamedChannel && !readOnly && (
                  <div className={mergeClasses(styles.msgActions, 'message-actions')}>
                    <IconButton
                      aria-label={`Reply to ${fromName} in a thread`}
                      tooltip={`Reply to ${fromName} in a thread`}
                      size="sm"
                      icon={<ArrowReply20Regular />}
                      onClick={handleReplyClick.bind(null, m)}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {readOnly ? (
        <div className={styles.readOnlyHint}>
          An agent-to-agent thread — you’re observing. Post in #team (or DM an agent) to join the conversation.
        </div>
      ) : (
        <div className={styles.composerArea}>
          {mention && mentionCandidates.length > 0 && (
            <div className={styles.mentionPopup} role="listbox" aria-label="Mention an agent">
              {mentionCandidates.map((a, i) => (
                <MentionItem
                  key={a.id}
                  agent={a}
                  index={i}
                  active={i === mentionIndex}
                  presence={presenceStatus(statuses[a.id]?.state, a.enabled)}
                  onPick={acceptMention}
                  onHover={setMentionIndex}
                />
              ))}
            </div>
          )}
          {replyTarget && (
            <div className={styles.replyBanner}>
              <Caption1 className={styles.replyBannerText}>
                Replying to {participantName(replyTarget)} — “{replyTarget.text.slice(0, 80)}”
              </Caption1>
              <IconButton aria-label="Cancel reply" size="sm" icon={<Dismiss20Regular />} onClick={clearReply} />
            </div>
          )}
          {sendError && <Caption1 className={styles.sendError}>{sendError}</Caption1>}
          <form className={styles.composer} onSubmit={handleSubmit}>
            <Textarea
              ref={composerRef}
              className={styles.composerInput}
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
                <IconButton
                  aria-label={spokenOn ? 'Spoken replies on' : 'Spoken replies off'}
                  tooltip={
                    spokenOn ? `Stop reading ${dmPeerName ?? 'agent'} replies aloud` : 'Read replies aloud in this DM'
                  }
                  icon={spokenOn ? <Speaker220Regular /> : <SpeakerMute20Regular />}
                  onClick={handleToggleSpoken}
                />
                {/* Scope = the DM channel id: the mic registry keys the voice
                    hotkey and recording glow by it (same registry the deck
                    columns use). */}
                <VoiceScopeContext.Provider value={channel ?? null}>
                  <LocalVoiceButton onSubmit={handleVoiceSubmit} />
                </VoiceScopeContext.Provider>
              </>
            )}
            {hostedVoiceReady && (
              <IconButton
                aria-label="Voice mode"
                tooltip={`Talk with ${dmPeerName ?? 'agent'}`}
                icon={<Mic20Regular />}
                onClick={openHostedVoice}
              />
            )}
            <IconButton aria-label="Send" icon={<Send20Regular />} onClick={submit} />
          </form>
          {hostedVoiceOpen && dmPeerId && (
            <ResidentHostedVoice agentId={dmPeerId} onClose={closeHostedVoice} onError={setSendError} />
          )}
        </div>
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
  const [uiUrl, setUiUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    residentApi
      .ensureSession(agentId)
      .then(({ uiUrl: url }) => {
        if (!cancelled) {
          setUiUrl(new URL(url, serverOrigin()).toString());
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

  if (!uiUrl) {
    return null; // waking the agent; the modal appears once its serve is up
  }
  return (
    <UiConfigProvider uiUrl={uiUrl}>
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
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const [boot, setBoot] = useState<
    | { phase: 'booting' }
    | { phase: 'ready'; uiUrl: string; sessionId: string }
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
      .then(({ sessionId, uiUrl }) => setBoot({ phase: 'ready', uiUrl, sessionId }))
      .catch((err: Error) => setBoot({ phase: 'error', message: err.message }));
  }, [agent.id]);

  useEffect(() => {
    launch();
  }, [launch]);

  // Idle-park can fire while this view is mounted (the park timer re-arms on
  // every run end): the process stops and the mounted App's WS dies. Swap the
  // dead iframe for an explicit parked state instead of leaving a corpse —
  // auto-relaunching here would keep the agent awake forever, defeating parking.
  useEffect(() => {
    if (boot.phase === 'ready' && runtimeState === 'parked') {
      setBoot({ phase: 'parked' });
    }
  }, [boot.phase, runtimeState]);

  const themedUrl = useMemo(() => {
    if (boot.phase !== 'ready') {
      return null;
    }
    const url = new URL(boot.uiUrl, serverOrigin());
    const theme = storeData.theme ?? 'teams-light';
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return url.toString();
  }, [boot, storeData.theme]);

  if (boot.phase === 'error') {
    return (
      <div className={styles.sessionCenter}>
        <span>{boot.message}</span>
        <Button size="sm" onClick={launch}>
          Retry
        </Button>
      </div>
    );
  }
  if (boot.phase === 'parked') {
    return (
      <div className={styles.sessionCenter}>
        <span>{agent.name} parked after sitting idle.</span>
        <Button size="sm" onClick={launch}>
          Wake
        </Button>
      </div>
    );
  }
  if (boot.phase !== 'ready' || !themedUrl) {
    return (
      <div className={styles.sessionCenter}>
        <Spinner size="small" />
        <span>Opening session…</span>
      </div>
    );
  }
  return (
    <div className={styles.sessionHost}>
      <OmniAgentsApp uiUrl={themedUrl} sessionId={boot.sessionId} onClientToolCall={swallowToolCall} />
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
    <Tooltip
      content={`Open ${agent.name}'s session — ${STATE_LABEL[state ?? 'parked']}${headline}`}
      relationship="description"
    >
      <InteractionTag size="small" shape="circular">
        <InteractionTagPrimary
          // 20px matches the AvatarContextProvider `InteractionTag size="small"`
          // publishes; the chip is a 24px pill, so an unsized avatar would
          // default to 32 and burst it.
          media={<AgentAvatar name={agent.name} colorId={agent.id} size={20} presence={presence} />}
          onClick={handleClick}
          // The button's own label wins over everything in its subtree, so the
          // avatar's off-screen status never reaches AT here — the label has
          // to carry presence itself. It quotes the badge, not STATE_LABEL: a
          // disabled agent reads `offline` while its runtime still says idle.
          aria-label={`Open ${agent.name}'s session — ${PRESENCE_LABEL[presence]}`}
        >
          {agent.name}
        </InteractionTagPrimary>
      </InteractionTag>
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
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const statuses = useStore($residentStatus);
  const def = (storeData.residentChannelDefs ?? []).find((c) => c.id === channel);
  // Absent member list = open channel: every agent (incl. future ones) is in.
  const isOpenChannel = !def?.members;
  const memberIds = useMemo(() => def?.members ?? roster.map((a) => a.id), [def?.members, roster]);
  const members = useMemo(() => roster.filter((a) => memberIds.includes(a.id)), [roster, memberIds]);

  const handleCheckedChange = useCallback(
    (_e: unknown, data: MenuCheckedValueChangeData) => {
      if (data.name === 'members') {
        void residentApi.setChannelMembers(channel, data.checkedItems);
      }
    },
    [channel]
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
    <div className={styles.memberBar}>
      <div className={styles.memberBarRow}>
        <Caption1>Members:</Caption1>
        {members.map((agent) => (
          <MemberChip key={agent.id} agent={agent} runtime={statuses[agent.id]} onOpen={onOpenAgent} />
        ))}
        {roster.length === 0 && <Caption1>no agents yet</Caption1>}
        {roster.length > 0 && members.length === 0 && (
          <Caption1 className={styles.memberWarning}>No members — posts here wake no agents</Caption1>
        )}
        <div className={styles.memberBarSpacer} />
        {isOpenChannel && roster.length > 0 && <Caption1>Open to all</Caption1>}
        {roster.length > 0 && (
          <Menu
            checkedValues={{ members: memberIds }}
            onCheckedValueChange={handleCheckedChange}
            positioning={{ position: 'below', align: 'end' }}
          >
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label="Manage members" icon={<PersonAdd20Regular />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={isOpenChannel ? <Checkmark20Regular /> : undefined}
                  disabled={isOpenChannel}
                  onClick={handleOpenToEveryone}
                >
                  Everyone (default)
                </MenuItem>
                <MenuDivider />
                {roster.map((agent) => (
                  <MenuItemCheckbox key={agent.id} name="members" value={agent.id}>
                    {agent.name}
                  </MenuItemCheckbox>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
      <Caption1 className={styles.memberBarNote}>
        Posts reach members on their next wakeup — mention an agent by name to wake it now.
      </Caption1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DM preview row (Conversations tab)
// ---------------------------------------------------------------------------

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

/** A DM thread row: the peer's identity (avatar + presence for your own
 *  threads, a stacked pair for agent↔agent), last-message snippet, time.
 *  This is the Conversations tab's browse row — sidebar DMs are nav rows
 *  (`DmNavRow`). */
/** One agent identity inside a DM row: who it is, plus its live presence. */
type DmAvatar = { name: string; colorId: string; presence?: AgentPresence };

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
   *  user↔agent thread, two for agent↔agent — each with its live presence. */
  avatars: ReadonlyArray<DmAvatar>;
  snippet: string;
  lastAt: number;
  unread: number;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const handleClick = useCallback(() => onSelect(channelId), [onSelect, channelId]);
  const single = avatars.length === 1 ? avatars[0] : null;
  return (
    <button type="button" className={styles.row} onClick={handleClick}>
      <span className={styles.rowTop}>
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
        <span className={styles.rowLines}>
          <span className={mergeClasses(styles.rowTitle, unread > 0 && styles.rowTitleUnread)}>
            <span className={styles.rowTitleText}>{title}</span>
          </span>
          <span className={styles.rowMeta}>{snippet}</span>
        </span>
        <span className={styles.rowTime}>{formatTimestamp(lastAt)}</span>
        {unread > 0 && <CounterBadge count={unread} size="small" color="brand" />}
      </span>
    </button>
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
  const styles = useStyles();
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
  const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => setMenuOpen(data.open), []);
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
    <div role="button" tabIndex={0} className={styles.row} onClick={handleClick} onKeyDown={handleRowKeyDown}>
      <span className={styles.rowTop}>
        <AgentAvatar name={agent.name} colorId={agent.id} size={32} presence={presenceStatus(state, agent.enabled)} />
        <span className={styles.rowLines}>
          <span className={styles.rowTitle}>
            <span className={styles.rowTitleText}>{agent.name}</span>
            {busy && <Badge color={stateBadgeColor(state)}>{STATE_LABEL[state ?? 'parked']}</Badge>}
            {!agent.enabled && <Badge color="default">Disabled</Badge>}
          </span>
          <span className={styles.rowMeta}>
            {agent.role}
            {projectLabel ? ` · ${projectLabel}` : ''}
            {runtime?.lastWakeupAt ? ` · woke ${formatTimestamp(runtime.lastWakeupAt)}` : ''}
          </span>
        </span>
        <span
          role="presentation"
          className={mergeClasses(styles.rowMenu, 'resident-row-menu', menuOpen && styles.rowMenuOpen)}
          onClick={stopPropagation}
        >
          <Menu open={menuOpen} onOpenChange={handleMenuOpenChange} positioning={{ position: 'below', align: 'end' }}>
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label={`${agent.name} actions`} icon={<MoreHorizontal20Regular />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Chat20Regular />} onClick={handleMessage}>
                  Message
                </MenuItem>
                <MenuItem icon={<FlashRegular />} disabled={!agent.enabled} onClick={handleWake}>
                  Wake now
                </MenuItem>
                <MenuItem onClick={handleToggle}>{agent.enabled ? 'Disable' : 'Enable'}</MenuItem>
                <MenuDivider />
                <MenuItem icon={<Delete20Regular />} className={styles.dangerMenuItem} onClick={handleDelete}>
                  Delete…
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
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
  const styles = useStyles();
  const isDesktop = useIsDesktop();
  const statuses = useStore($residentStatus);
  return (
    <>
      {/* Mobile titles via the TopAppBar; the band then only carries the
          action. */}
      <div className={styles.bandHeader}>
        <div className={styles.bandTitleRow}>
          {isDesktop && <span className={styles.bandTitle}>Agents</span>}
          <div className={styles.bandSpacer} />
          <Button size="sm" leftIcon={<Add20Regular />} onClick={onNewAgent}>
            New agent
          </Button>
        </div>
      </div>
      {roster.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Resident agents are named, persistent teammates: they wake on messages and mentions, work in their own sandbox, talk in #team, and distill each day into durable memory."
          action={
            <Button size="sm" leftIcon={<Add20Regular />} onClick={onNewAgent}>
              New agent
            </Button>
          }
        />
      ) : (
        <div className={styles.list}>
          {/* Team-level configuration lives with the team directory. */}
          <button type="button" className={styles.row} onClick={onOpenHandbook}>
            <span className={styles.rowTop}>
              <BookOpen20Regular />
              <span className={styles.rowTitle}>
                <span className={styles.rowTitleText}>Handbook</span>
              </span>
            </span>
            <span className={styles.rowMeta}>Shared team rules — every agent receives them on wake</span>
          </button>
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
    return <Checkbox label={project.label} checked={checked} onCheckedChange={handleChange} />;
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
}: {
  projectIds: string[];
  profileName: string;
  projects: Project[];
  sandboxContext: SandboxContext;
  onProjectIdsChange: (projectIds: string[]) => void;
  onProfileChange: (profileName: string) => void;
}): React.JSX.Element {
  const styles = useStyles();
  const handleToggle = useCallback(
    (id: string) => {
      onProjectIdsChange(projectIds.includes(id) ? projectIds.filter((p) => p !== id) : [...projectIds, id]);
    },
    [onProjectIdsChange, projectIds]
  );
  return (
    <>
      <Field
        label={infoLabel(
          'Projects',
          "Scoped agents launch with every selected project's sources mounted (with their git credentials); their private home rides along as the `home` mount. None = generalist with only the home workspace."
        )}
      >
        <div className={styles.projectScopeList}>
          {projects.map((p) => (
            <ProjectScopeRow key={p.id} project={p} checked={projectIds.includes(p.id)} onToggle={handleToggle} />
          ))}
        </div>
      </Field>
      <Field
        label={infoLabel(
          'Sandbox',
          "Where this agent's sessions run. Applied on save — the agent parks and its next wakeup starts with the new configuration."
        )}
      >
        <SandboxPicker value={profileName} onChange={onProfileChange} context={sandboxContext} />
      </Field>
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
}: {
  agent: ResidentAgent;
  projects: Project[];
  sandboxContext: SandboxContext;
}): React.JSX.Element {
  const styles = useStyles();
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
    <div className={styles.detailBody}>
      <div className={styles.form}>
        <Field label="Name" hint={`DM address: @${residentHandle(name.trim() || agent.name)} — it follows the name.`}>
          <Input value={name} onChange={handleName} />
        </Field>
        <Field label="Role">
          <Input value={role} onChange={handleRole} />
        </Field>
        <Field
          label="Persona"
          hint="Who this agent is — voice, doctrine, specialization. Applied on its next session start."
        >
          <Textarea value={persona} rows={8} onChange={handlePersona} />
        </Field>
        <AssignmentFields
          projectIds={projectIds}
          profileName={profileName}
          projects={projects}
          sandboxContext={sandboxContext}
          onProjectIdsChange={setProjectIds}
          onProfileChange={setProfileName}
        />
        <Field
          label={infoLabel(
            'Morning wakeup',
            'The daily planning beat — the agent wakes with its memories and the overnight digest. If the app is closed at that hour, the beat catches up (marked late) when the app next opens that day.'
          )}
        >
          <Select value={morningHour === null ? 'off' : String(morningHour)} onChange={handleMorningHour}>
            <option value="off">Off — no morning beat</option>
            {MORNING_HOUR_OPTIONS.map((h) => (
              <option key={h} value={String(h)}>
                {`${h}:00`}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={infoLabel(
            'Workspace superuser',
            'Grants tools over your whole deck: see every column (list_workspace), instruct and approve other agents (column_send / column_decide), open and close columns, and drive any column’s apps. The tools work while the app is open; when it’s closed they return an error the agent understands. The global voice hotkey targets the first enabled superuser’s DM.'
          )}
        >
          <Switch label="Can observe and drive the workspace" checked={superuser} onChange={handleSuperuser} />
        </Field>

        <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab (durable memory editor)
// ---------------------------------------------------------------------------

function AgentMemory({ agent }: { agent: ResidentAgent }): React.JSX.Element {
  const styles = useStyles();
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
    <div className={styles.detailBody}>
      <div className={styles.form}>
        <Field
          label={infoLabel(
            `Durable memory (${memories.length})`,
            'Keyed facts the agent maintains with its remember/forget tools (curated nightly at reflection); you can prune or add here. Changes reach the agent on its next run.'
          )}
        >
          <div>
            {memories.length === 0 && (
              <Caption1>Nothing remembered yet. The agent saves facts with its remember tool as it works.</Caption1>
            )}
            {memories.map((m) => (
              <MemoryRow key={m.key} memoryKey={m.key} text={m.text} onForget={forgetMemory} />
            ))}
            <div className={styles.memoryAdd}>
              <Input value={newKey} placeholder="key (optional)" onChange={handleNewKey} />
              <Input
                className={styles.composerInput}
                value={newMemory}
                placeholder="Add a fact the agent should always carry…"
                onChange={handleNewMemory}
              />
              <Button size="sm" onClick={addMemory} isDisabled={!newMemory.trim()}>
                {memoryKey(newKey) && memories.some((m) => m.key === memoryKey(newKey)) ? 'Update' : 'Add'}
              </Button>
            </div>
          </div>
        </Field>
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
  const styles = useStyles();
  const handleForget = useCallback(() => onForget(key), [onForget, key]);
  return (
    <div className={styles.memoryRow}>
      <span className={styles.idChip}>{key}</span>
      <span className={styles.memoryText}>{text}</span>
      <IconButton aria-label="Forget memory" size="sm" icon={<Delete20Regular />} onClick={handleForget} />
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
  const styles = useStyles();
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
      <EmptyState
        title="No conversations yet"
        description={`DMs ${agent.name} has — with you or with other agents — appear here.`}
      />
    );
  }

  return (
    <div className={styles.list}>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent detail: header + Session | Conversations | Memory | Settings tabs
// ---------------------------------------------------------------------------

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
  const styles = useStyles();
  const statuses = useStore($residentStatus);
  const runtime = statuses[agent.id];
  const [tab, setTab] = useState<'session' | 'conversations' | 'memory' | 'settings'>('session');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleTabSelect = useCallback((_: unknown, data: { value: unknown }) => {
    setTab(data.value as 'session' | 'conversations' | 'memory' | 'settings');
  }, []);

  const handleMessage = useCallback(() => onMessage(agent.id), [onMessage, agent.id]);

  const handleWake = useCallback(() => {
    void residentApi.wake(agent.id);
  }, [agent.id]);

  const handleEnabledChange = useCallback(
    (_: unknown, data: { checked: boolean }) => {
      void residentApi.update(agent.id, { enabled: data.checked });
    },
    [agent.id]
  );

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
      <div className={styles.bandHeader}>
        <div className={styles.bandTitleRow}>
          <AgentAvatar
            name={agent.name}
            colorId={agent.id}
            size={40}
            presence={presenceStatus(runtime?.state, agent.enabled)}
          />
          <span className={styles.bandTitle}>{agent.name}</span>
          <Badge color={stateBadgeColor(runtime?.state)}>{STATE_LABEL[runtime?.state ?? 'parked']}</Badge>
          {!agent.enabled && <Badge color="default">Disabled</Badge>}
          <div className={styles.bandSpacer} />
          <Button size="sm" leftIcon={<Chat20Regular />} onClick={handleMessage}>
            Message
          </Button>
          <Button size="sm" leftIcon={<FlashRegular />} onClick={handleWake} isDisabled={!agent.enabled}>
            Wake now
          </Button>
          <Switch label="Enabled" checked={agent.enabled} onChange={handleEnabledChange} />
          <Menu positioning={{ position: 'below', align: 'end' }}>
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label="More actions" icon={<MoreHorizontal20Regular />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Delete20Regular />} className={styles.dangerMenuItem} onClick={openConfirmDelete}>
                  Delete agent…
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
        <Caption1>
          <span className={styles.idChip}>@{residentHandle(agent.name)}</span>
          {` · ${agent.role}`}
          {runtime?.decisions ? ` · ${runtime.decisions} wakeups` : ''}
          {runtime?.lastReason ? ` · last: ${runtime.lastReason}` : ''}
        </Caption1>
        <TabList size="small" selectedValue={tab} onTabSelect={handleTabSelect}>
          {/* The raw session is the debugging view — DMs are the front door
              for talking to an agent (the Message button up top). */}
          <Tab value="session">Session (debug)</Tab>
          <Tab value="conversations">Conversations</Tab>
          <Tab value="memory">Memory</Tab>
          <Tab value="settings">Settings</Tab>
        </TabList>
      </div>
      {tab === 'session' ? (
        agent.enabled ? (
          <ResidentSessionView agent={agent} />
        ) : (
          <div className={styles.sessionCenter}>
            <span>{agent.name} is disabled. Enable it to open its session.</span>
          </div>
        )
      ) : tab === 'conversations' ? (
        <AgentConversations agent={agent} roster={roster} onOpenChannel={onOpenChannel} />
      ) : tab === 'memory' ? (
        <AgentMemory agent={agent} />
      ) : (
        <AgentSettings agent={agent} projects={projects} sandboxContext={sandboxContext} />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${agent.name}?`}
        description="The agent, its durable memories, and its DM threads are removed. Its workspace folder stays on disk."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onClose={closeConfirmDelete}
      />
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
  const styles = useStyles();
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
    <div className={styles.detailBody}>
      <div className={styles.form}>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
        <Field
          label="Name"
          required
          hint={name.trim() ? `DM address: @${residentHandle(name)} — it follows the name` : undefined}
        >
          <Input value={name} placeholder="Scout" onChange={handleName} />
        </Field>
        <Field label="Role" hint="One line — what this agent is for.">
          <Input value={role} placeholder="research & codebase reconnaissance" onChange={handleRole} />
        </Field>
        <Field label="Persona" hint="Voice, doctrine, working style. Durable memory accumulates on top of this.">
          <div className={styles.personaField}>
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
        </Field>
        <AssignmentFields
          projectIds={projectIds}
          profileName={profileName}
          projects={projects}
          sandboxContext={sandboxContext}
          onProjectIdsChange={setProjectIds}
          onProfileChange={setProfileName}
        />
        <div className={styles.statusLine}>
          <Button variant="primary" onClick={handleCreate} isDisabled={!name.trim() || creating}>
            {creating ? 'Creating…' : 'Create agent'}
          </Button>
          <Button onClick={onCancel} isDisabled={creating}>
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
  const styles = useStyles();
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
      <div className={styles.handbookBody}>
        <FormSkeleton fields={4} />
      </div>
    );
  }
  return (
    <div className={styles.handbookPane}>
      <div className={styles.handbookHeader}>
        <span className={styles.bandTitle}>Handbook</span>
        {meta && (
          <span className={styles.rowMeta}>
            Last updated {formatTimestamp(meta.updatedAt)} by {editorName}
          </span>
        )}
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>
      <div className={styles.handbookBody}>
        <Suspense
          fallback={
            <div className={styles.sessionCenter}>
              <Spinner size="small" />
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
  const styles = useStyles();
  const isDesktop = useIsDesktop();
  const isGlass = useStore($glassEnabled);
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
        <div className={styles.feedHeader}>
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
          <span className={styles.feedHeaderTitle}>{dmTitle(selectedChannel)}</span>
          {selectedIsAgentDm && <span className={styles.feedHeaderMeta}>agent↔agent — observed</span>}
        </div>
      );
    } else {
      const def = channelDefs.find((c) => c.id === selectedChannel);
      const headerMeta =
        def?.description ?? (selectedChannel === TEAM_CHANNEL ? 'All-hands — everyone reads it' : null);
      feedHeader = (
        <div className={styles.feedHeader}>
          <span className={styles.feedHeaderTitle}>#{selectedChannel}</span>
          {headerMeta && <span className={styles.feedHeaderMeta}>{headerMeta}</span>}
        </div>
      );
    }
  }

  const detailBody = creating ? (
    <>
      {isDesktop && (
        <div className={styles.bandHeader}>
          <div className={styles.bandTitleRow}>
            <span className={styles.bandTitle}>New agent</span>
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
    <EmptyState
      title="No agents yet"
      description="Resident agents are named, persistent teammates: they wake on messages and mentions, work in their own sandbox, talk in #team, and distill each day into durable memory."
      action={
        <Button size="sm" leftIcon={<Add20Regular />} onClick={startCreate}>
          New agent
        </Button>
      }
    />
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
    <ConfirmDialog
      open={pendingDeleteAgent !== null}
      onClose={closeDeleteAgent}
      onConfirm={confirmDeleteAgent}
      title={`Delete ${pendingDeleteAgent?.name ?? ''}?`}
      description="The agent, its durable memories, and its DM threads are removed. Its workspace folder stays on disk."
      confirmLabel="Delete"
      destructive
    />
  );

  // Mobile: the surface always fills the screen. A TopAppBar titles it and
  // leads with a back arrow at depth (agent detail / create form → roster)
  // or the drawer handle at a surface root. Routines titles itself at every
  // level (band header + internal bars).
  if (!isDesktop) {
    if (routinesOpen) {
      return (
        <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
          <div className={mergeClasses(styles.detailPane, isGlass && styles.detailPaneGlass)}>
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
      <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
        <div className={mergeClasses(styles.detailPane, isGlass && styles.detailPaneGlass)}>
          <TopAppBar title={mobileTitle} {...(mobileBack ? { onBack: mobileBack } : { onMenu: openMobileNav })} />
          {detailBody}
        </div>
        {agentDialogs}
      </div>
    );
  }

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={mergeClasses(styles.detailPane, isGlass && styles.detailPaneGlass)}>{detailBody}</div>
      {agentDialogs}
    </div>
  );
}
