import { useStore } from '@nanostores/react';
import { ArrowLeft, Ellipsis, Rocket, Trash2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
/**
 * Detail view for a single inbox item. On desktop it fills the right pane
 * next to the list; on mobile (`showBack`) it replaces the list and gets a
 * back header. Standard detail anatomy, matching the ticket Overview: the
 * title (with the triage actions on its row) above a content + properties
 * split — the note on the left, Status / Project / Details in the right
 * rail. Auto-saves title/note on blur.
 *
 * Promoted tombstones render read-only — no edits, just a "this became X" banner.
 */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { toast } from '@/renderer/features/Toast/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, ProjectId } from '@/shared/types';

import { inboxApi } from './state';

export type InboxItemDetailProps = {
  item: InboxItem;
  onBack: () => void;
  /** Mobile: render the back header (the detail replaced the list). */
  showBack?: boolean;
};

export const InboxItemDetail = memo(({ item, onBack, showBack = true }: InboxItemDetailProps) => {
  const store = useStore(persistedStoreApi.$atom);

  const isArchived = !!item.promotedTo;

  // Local edit buffers — seeded once from props on mount. The parent keys
  // this component on `item.id`, so navigating to a different item gives
  // us a fresh lifecycle with fresh initial state. That keying is what
  // makes the buffers safe: useState initializers run on mount, so there
  // is no code path where a stale buffer from a previous item can end up
  // associated with a different item's id.
  //
  // Same-id external updates (store broadcasts) intentionally do NOT
  // refresh these buffers — clobbering a user's in-progress edit would be
  // worse than showing slightly stale data.
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');

  // -------------------------------------------------------------------------
  // Save handlers (auto-save on blur)
  // -------------------------------------------------------------------------

  const saveTitleNote = useCallback(() => {
    if (isArchived) {
      return;
    }
    const nextTitle = title.trim() || 'Untitled';
    const nextNote = note.trim();
    const titleChanged = nextTitle !== item.title;
    const noteChanged = nextNote !== (item.note ?? '');
    if (!titleChanged && !noteChanged) {
      return;
    }
    void inboxApi.update(item.id, {
      ...(titleChanged ? { title: nextTitle } : {}),
      ...(noteChanged ? { note: nextNote } : {}),
    });
  }, [isArchived, title, note, item]);

  const setProjectId = useCallback(
    (id: ProjectId | null) => {
      if (isArchived) {
        return;
      }
      if ((item.projectId ?? null) === id) {
        return;
      }
      void inboxApi.update(item.id, { projectId: id });
    },
    [isArchived, item]
  );

  // -------------------------------------------------------------------------
  // Flush-on-unmount.
  //
  // If the user types in a field and navigates away without blurring
  // (clicks another inbox item, hits the back button, closes the panel),
  // the in-progress edit would otherwise be lost. The latest save closures
  // are captured in a ref on every render so the unmount cleanup can call
  // the most recent version — which closes over the current buffers AND
  // the current `item.id`, so the write always lands on the right row.
  //
  // The cleanup effect has an empty dep array so it only fires once on
  // real unmount (i.e. when the parent swaps our `key` for a new item or
  // when the panel closes), not after every keystroke.
  // -------------------------------------------------------------------------
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    saveTitleNote();
  };
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleStatusChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (event.target.value === 'later') {
        void inboxApi.defer(item.id);
      } else {
        void inboxApi.reactivate(item.id);
      }
    },
    [item.id]
  );

  const handleTitleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
  }, []);

  const handleNoteChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setNote(event.target.value);
  }, []);

  const handleProjectChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setProjectId(event.target.value || null);
    },
    [setProjectId]
  );

  const handlePromoteToTicket = useCallback(() => {
    const projectId = item.projectId ?? store.projects.find((p) => p.isPersonal)?.id ?? store.projects[0]?.id;
    if (!projectId) {
      toast.warning('No project to promote into', 'Create a project first, then promote this item.');
      return;
    }
    const projectLabel = store.projects.find((p) => p.id === projectId)?.label ?? 'project';
    void inboxApi.promoteToTicket(item.id, { projectId }).then((ticket) => {
      // Say where it went and offer the jump — the item itself just moved to
      // the Archive tab, which is otherwise silent.
      toast.success(`Promoted to task in ${projectLabel}`, undefined, {
        action: { label: 'Open', onClick: ticketApi.goToTicket.bind(null, ticket.id) },
      });
    });
  }, [item.id, item.projectId, store.projects]);

  const handlePromoteToProject = useCallback(() => {
    void inboxApi.promoteToProject(item.id, { label: item.title });
  }, [item.id, item.title]);

  const handleDrop = useCallback(() => {
    void inboxApi.remove(item.id);
    onBack();
  }, [item.id, onBack]);

  // -------------------------------------------------------------------------
  // Keyboard: Escape → back (mobile) / deselect (desktop)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const capturedLabel = useMemo(() => `Captured ${formatTimestamp(item.createdAt)}`, [item.createdAt]);

  return (
    <div className="flex flex-col h-full w-full">
      {showBack && (
        <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1 shrink-0">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label="Back">
            <ArrowLeft />
            Back
          </Button>
        </div>
      )}

      {/* Header band — same geometry as the ticket page's ProjectPageHeader:
             full-bleed title row with the triage actions at the right. */}
      <div className="flex flex-col gap-0.5 pl-5 pr-5 pt-5 pb-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            className={`${'flex-1 min-w-0 bg-transparent border-0 p-0 text-2xl font-semibold leading-8 text-foreground font-inherit focus:outline-none placeholder:text-muted-foreground'} h-auto`}
            value={title}
            onChange={handleTitleChange}
            onBlur={saveTitleNote}
            placeholder="Untitled"
            readOnly={isArchived}
            aria-label="Item title"
          />

          {!isArchived && (
            <>
              <Button size="sm" onClick={handlePromoteToTicket}>
                <Rocket />
                Promote to task
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={handlePromoteToProject}>
                      <Rocket />
                      Promote to project
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDrop} className="text-destructive">
                      <Trash2 />
                      Drop
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      {/* Scrollable content — centered like the ticket Overview. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          {isArchived && (
            <Alert>
              <AlertDescription>
                Promoted to a {item.promotedTo!.kind} on {new Date(item.promotedTo!.at).toLocaleDateString()} — kept for
                history. Editing is disabled.
              </AlertDescription>
            </Alert>
          )}

          {/* Content + properties rail — same split as the ticket Overview. */}
          <div className="flex items-start gap-8 [@media(max-width:1000px)]:flex-col">
            <div className="flex-1 min-w-0 [@media(max-width:1000px)]:w-full [@media(max-width:1000px)]:flex-none">
              <Textarea
                className="w-full min-h-20 resize-y bg-transparent border-0 p-0 text-sm text-muted-foreground font-inherit leading-6 focus:outline-none placeholder:text-muted-foreground"
                value={note}
                onChange={handleNoteChange}
                onBlur={saveTitleNote}
                placeholder="Add a note — what does done look like? Anything out of scope?"
                readOnly={isArchived}
              />
            </div>

            <aside
              className="w-60 shrink-0 flex flex-col gap-5 [@media(max-width:1000px)]:w-full"
              aria-label="Item properties"
            >
              {!isArchived && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
                  <Select className="w-full" value={item.status} onChange={handleStatusChange} aria-label="Status">
                    <option value="new">Inbox</option>
                    <option value="later">Later</option>
                  </Select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project</span>
                <Select
                  className="w-full"
                  value={item.projectId ?? ''}
                  onChange={handleProjectChange}
                  disabled={isArchived}
                  aria-label="Project"
                >
                  <option value="">No project</option>
                  {store.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</span>
                <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                  <span>{capturedLabel}</span>
                  {item.updatedAt !== item.createdAt && <span>Updated {formatTimestamp(item.updatedAt)}</span>}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
});
InboxItemDetail.displayName = 'InboxItemDetail';
