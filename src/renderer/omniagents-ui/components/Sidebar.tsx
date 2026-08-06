import './Sidebar.css';

import { Archive, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
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
  SidebarMenuAction,
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
type Bucket = 'pinned' | 'today' | 'yesterday' | 'previous7' | 'previous30' | 'older';
const BUCKET_LABELS: Record<Bucket, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  previous7: 'Previous 7 days',
  previous30: 'Previous 30 days',
  older: 'Older',
};
const BUCKET_ORDER: Bucket[] = ['pinned', 'today', 'yesterday', 'previous7', 'previous30', 'older'];

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
  managementSupported = false,
  searchResults = null,
  searching = false,
  onSearchQueryChange,
  busyThreadIds = new Set<string>(),
  operationError,
  onDismissOperationError,
  onRename,
  onSetPinned,
  onArchive,
  onRestore,
}: {
  open: boolean;
  sessions: SessionItem[];
  selectedId?: string;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  managementSupported?: boolean;
  searchResults?: SessionItem[] | null;
  searching?: boolean;
  onSearchQueryChange?: (query: string) => void;
  busyThreadIds?: ReadonlySet<string>;
  operationError?: string | null;
  onDismissOperationError?: () => void;
  onRename?: (id: string, title: string) => Promise<void>;
  onSetPinned?: (id: string, pinned: boolean) => Promise<void>;
  onArchive?: (id: string) => Promise<void>;
  onRestore?: (id: string) => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [archivedUndo, setArchivedUndo] = useState<{ id: string; title: string } | null>(null);
  const isDesktop = useIsDesktop();

  const nonEmpty = useMemo(() => sessions.filter((s) => s.message_count > 0), [sessions]);

  const locallyFiltered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return nonEmpty;
    }
    return nonEmpty.filter((s) => {
      const title = generateSessionTitle(s).toLowerCase();
      return title.includes(q) || s.id.toLowerCase().includes(q);
    });
  }, [nonEmpty, searchQuery]);

  const filtered =
    managementSupported && searchQuery.trim() && searchResults !== null ? searchResults : locallyFiltered;

  /* Group by bucket, sort each bucket newest-first. */
  const grouped = useMemo(() => {
    const buckets: Record<Bucket, SessionItem[]> = {
      pinned: [],
      today: [],
      yesterday: [],
      previous7: [],
      previous30: [],
      older: [],
    };
    for (const s of filtered) {
      buckets[s.pinned ? 'pinned' : bucketFor(sessionTimestamp(s))].push(s);
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

  const runAction = (action: (() => Promise<void>) | undefined) => {
    if (action) {
      void action().catch(() => {});
    }
  };

  const renderSessionRow = (s: SessionItem) => {
    const title = generateSessionTitle(s);
    const timestamp = formatRelativeTime(
      (s as { last_message?: { timestamp?: string } }).last_message?.timestamp ??
        (s as { created_at?: string }).created_at
    );

    const busy = busyThreadIds.has(s.id);

    return (
      <SidebarMenuItem key={s.id}>
        <SidebarMenuButton className="min-w-0 pr-8" isActive={selectedId === s.id} onClick={() => handleSelect(s.id)}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              {s.pinned ? <Pin className="size-3 shrink-0 fill-current" aria-label="Pinned" /> : null}
              <span className="truncate">{title}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {searchQuery.trim() && s.searchPreview ? s.searchPreview : timestamp}
            </span>
          </div>
        </SidebarMenuButton>
        {managementSupported ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuAction
                aria-label={`Conversation actions for ${title}`}
                disabled={busy}
                showOnHover
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal />
              </SidebarMenuAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DropdownMenuItem
                onSelect={() => {
                  setRenameTarget({ id: s.id, title });
                  setRenameValue(title);
                }}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runAction(() => onSetPinned?.(s.id, !s.pinned) ?? Promise.resolve())}>
                {s.pinned ? <PinOff /> : <Pin />}
                {s.pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  runAction(async () => {
                    await onArchive?.(s.id);
                    setArchivedUndo({ id: s.id, title });
                  })
                }
              >
                <Archive /> Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </SidebarMenuItem>
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
              onChange={(event) => {
                setSearchQuery(event.target.value);
                onSearchQueryChange?.(event.target.value);
              }}
            />
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent className={!isDesktop ? 'omniagents-sidebar-overlay-body' : undefined}>
        {operationError ? (
          <div
            role="alert"
            className="mx-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1">{operationError}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss error"
              onClick={onDismissOperationError}
            >
              <X />
            </Button>
          </div>
        ) : null}
        {archivedUndo ? (
          <div role="status" className="mx-3 flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <span className="min-w-0 flex-1 truncate">Archived {archivedUndo.title}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                runAction(async () => {
                  await onRestore?.(archivedUndo.id);
                  setArchivedUndo(null);
                })
              }
            >
              Undo
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss archive notice"
              onClick={() => setArchivedUndo(null)}
            >
              <X />
            </Button>
          </div>
        ) : null}
        {!hasAnySession ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-6 text-center text-muted-foreground">
            <MessageCircle className="mb-2 size-8 opacity-50" />
            <div>No conversations yet</div>
            <span className="text-xs text-muted-foreground">Start chatting to create your first session</span>
          </div>
        ) : searching ? (
          <div className="py-4 text-center text-sm text-muted-foreground">Searching conversations…</div>
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
                <SidebarMenu>{items.map(renderSessionRow)}</SidebarMenu>
              </SidebarGroup>
            );
          })
        )}
      </SidebarContent>
    </ShadcnSidebar>
  );

  return (
    <>
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
                <SheetDescription>Browse and manage conversations.</SheetDescription>
              </SheetHeader>
              {contents}
            </SheetContent>
          </Sheet>
        )}
      </SidebarProvider>
      <Dialog open={renameTarget !== null} onOpenChange={(nextOpen) => !nextOpen && setRenameTarget(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const title = renameValue.trim();
              if (!renameTarget || !title || !onRename) {
                return;
              }
              void onRename(renameTarget.id, title)
                .then(() => setRenameTarget(null))
                .catch(() => {});
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>
                Choose a title that will be visible anywhere this conversation appears.
              </DialogDescription>
            </DialogHeader>
            <Input
              aria-label="Conversation title"
              autoFocus
              maxLength={200}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={!renameValue.trim() || Boolean(renameTarget && busyThreadIds.has(renameTarget.id))}
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default Sidebar;
