import './Sidebar.css';

import { MessageCircle, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/renderer/ds/ui/sheet';
// Pick desktop vs mobile layout via matchMedia rather than relying on
// `hidden md:flex` / `md:hidden` utilities. Those patterns are broken in this
// app because a pre-compiled shadcn/ai-elements CSS bundle ships a plain
// `.hidden{display:none}` rule that loads AFTER Tailwind v4's output and wins
// the cascade over `.md:flex`, so the desktop-inline sidebar would stay
// `display: none` at every viewport size.
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/renderer/ds/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { formatRelativeTime, generateSessionTitle } from '@/renderer/omniagents-ui/lib/utils';

import type { SessionItem } from './SessionList';
function useIsDesktop(breakpointPx = 768): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(`(min-width: ${breakpointPx}px)`).matches : true
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const mql = window.matchMedia(`(min-width: ${breakpointPx}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpointPx]);
  return isDesktop;
}

// ── Date bucketing — matches ChatGPT / Claude conventions ─────────────────
type Bucket = 'today' | 'yesterday' | 'previous7' | 'previous30' | 'older';
const BUCKET_LABELS: Record<Bucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  previous7: 'Previous 7 days',
  previous30: 'Previous 30 days',
  older: 'Older',
};
const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'previous7', 'previous30', 'older'];

function sessionTimestamp(s: SessionItem): number {
  const raw =
    (s as { last_message?: { timestamp?: string }; created_at?: string }).last_message?.timestamp ??
    (s as { created_at?: string }).created_at ??
    '';
  const n = Date.parse(raw);
  return Number.isNaN(n) ? 0 : n;
}

function bucketFor(ts: number): Bucket {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const yesterdayStartMs = todayStartMs - dayMs;
  if (ts >= todayStartMs) {
    return 'today';
  }
  if (ts >= yesterdayStartMs) {
    return 'yesterday';
  }
  if (now - ts < 7 * dayMs) {
    return 'previous7';
  }
  if (now - ts < 30 * dayMs) {
    return 'previous30';
  }
  return 'older';
}

export function Sidebar({
  open,
  sessions,
  selectedId,
  onClose,
  onNewChat,
  onSelect,
}: {
  open: boolean;
  sessions: SessionItem[];
  selectedId?: string;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const isDesktop = useIsDesktop();

  const nonEmpty = useMemo(() => sessions.filter((s) => s.message_count > 0), [sessions]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return nonEmpty;
    }
    return nonEmpty.filter((s) => {
      const title = generateSessionTitle(s).toLowerCase();
      return title.includes(q) || s.id.toLowerCase().includes(q);
    });
  }, [nonEmpty, searchQuery]);

  /* Group by bucket, sort each bucket newest-first. */
  const grouped = useMemo(() => {
    const buckets: Record<Bucket, SessionItem[]> = {
      today: [],
      yesterday: [],
      previous7: [],
      previous30: [],
      older: [],
    };
    for (const s of filtered) {
      buckets[bucketFor(sessionTimestamp(s))].push(s);
    }
    for (const bucket of BUCKET_ORDER) {
      buckets[bucket].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    }
    return buckets;
  }, [filtered]);

  const handleSelect = (id: string) => {
    onSelect(id);
    if (!isDesktop) {
      onClose();
    }
  };

  const renderSessionRow = (s: SessionItem) => {
    const title = generateSessionTitle(s);
    const timestamp = formatRelativeTime(
      (s as { last_message?: { timestamp?: string } }).last_message?.timestamp ??
        (s as { created_at?: string }).created_at
    );

    return (
      <SidebarMenuButton
        key={s.id}
        className="min-w-0"
        isActive={selectedId === s.id}
        onClick={() => handleSelect(s.id)}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{title}</span>
          {/* Date only — message counts read as noise at a glance and say
                   nothing about what the conversation contains. */}
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
      </SidebarMenuButton>
    );
  };

  const hasAnySession = nonEmpty.length > 0;
  const hasResults = filtered.length > 0;

  const contents = (
    <ShadcnSidebar
      collapsible={isDesktop ? 'offcanvas' : 'none'}
      className={cn('min-w-72 max-w-72 bg-background', !isDesktop && 'omniagents-sidebar-overlay w-full')}
    >
      <SidebarHeader>
        <div className={cn('flex flex-col gap-2 pt-8 pb-5', !isDesktop && 'omniagents-sidebar-overlay-header')}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold tracking-tight">Conversations</h2>
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="New chat" onClick={onNewChat}>
                    <Plus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New chat</TooltipContent>
              </Tooltip>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close sidebar" onClick={onClose}>
                <X />
              </Button>
            </div>
          </div>
          {hasAnySession ? (
            <SidebarInput
              placeholder="Search conversations…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent className={!isDesktop ? 'omniagents-sidebar-overlay-body' : undefined}>
        {!hasAnySession ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-6 text-center text-muted-foreground">
            <MessageCircle className="mb-2 size-8 opacity-50" />
            <div>No conversations yet</div>
            <span className="text-xs text-muted-foreground">Start chatting to create your first session</span>
          </div>
        ) : !hasResults ? (
          <div className="py-4 text-center text-muted-foreground">No matching conversations</div>
        ) : (
          BUCKET_ORDER.map((bucket) => {
            const items = grouped[bucket];
            if (items.length === 0) {
              return null;
            }
            return (
              <SidebarGroup key={bucket}>
                <SidebarGroupLabel>{BUCKET_LABELS[bucket]}</SidebarGroupLabel>
                <SidebarMenu>
                  {items.map(renderSessionRow).map((row) => (
                    <SidebarMenuItem key={row.key}>{row}</SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            );
          })
        )}
      </SidebarContent>
    </ShadcnSidebar>
  );

  return (
    <SidebarProvider
      open={isDesktop ? open : true}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      className="omniagents-sidebar-provider min-h-0 w-auto"
    >
      {isDesktop ? (
        contents
      ) : (
        <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
          <SheetContent side="left" showCloseButton={false} className="w-72 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversations</SheetTitle>
              <SheetDescription>Browse and open conversations.</SheetDescription>
            </SheetHeader>
            {contents}
          </SheetContent>
        </Sheet>
      )}
    </SidebarProvider>
  );
}

export default Sidebar;
