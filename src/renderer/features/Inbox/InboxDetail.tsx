import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiArrowLeftBold } from 'react-icons/pi';

import { Button, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId, InboxItemStatus } from '@/shared/types';

import { $inboxItems, inboxApi } from './state';

const inputClass =
  'w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500';

const selectClass =
  'rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-500';

export const InboxDetail = memo(
  ({ itemId, onBack }: { itemId: InboxItemId; onBack: () => void }) => {
    const itemsMap = useStore($inboxItems);
    const store = useStore(persistedStoreApi.$atom);
    const item = itemsMap[itemId];

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dirty, setDirty] = useState(false);

    // Sync local state when item changes externally
    useEffect(() => {
      if (!item) return;
      setTitle(item.title);
      setDescription(item.description ?? '');
      setDirty(false);
    }, [item?.id, item?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const linkedTickets = useMemo(() => {
      if (!item?.linkedTicketIds?.length) return [];
      return item.linkedTicketIds
        .map((tid) => store.tickets.find((t) => t.id === tid))
        .filter(Boolean);
    }, [item?.linkedTicketIds, store.tickets]);

    const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setTitle(e.target.value);
      setDirty(true);
    }, []);

    const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDescription(e.target.value);
      setDirty(true);
    }, []);

    const handleSave = useCallback(async () => {
      if (!title.trim()) return;
      await inboxApi.updateItem(itemId, {
        title: title.trim(),
        description: description.trim() || undefined,
      });
      setDirty(false);
    }, [itemId, title, description]);

    const handleStatusChange = useCallback(
      (e: React.ChangeEvent<HTMLSelectElement>) => {
        void inboxApi.updateItem(itemId, { status: e.target.value as InboxItemStatus });
      },
      [itemId]
    );

    const handleProjectChange = useCallback(
      (e: React.ChangeEvent<HTMLSelectElement>) => {
        void inboxApi.updateItem(itemId, { projectId: e.target.value || undefined });
      },
      [itemId]
    );

    const handleDefer = useCallback(() => {
      void inboxApi.updateItem(itemId, { status: 'deferred' });
    }, [itemId]);

    const handleDelete = useCallback(() => {
      void inboxApi.removeItem(itemId);
      onBack();
    }, [itemId, onBack]);

    if (!item) {
      return (
        <div className="flex items-center justify-center h-full">
          <p className="text-fg-muted text-sm">Item not found</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col w-full h-full">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
          <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={onBack} />
          <span className="text-sm font-semibold text-fg truncate flex-1">{item.title}</span>
          <span className="text-xs text-fg-subtle shrink-0">{new Date(item.createdAt).toLocaleDateString()}</span>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-6 max-w-2xl px-6 py-5">
            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg">Title</label>
              <input value={title} onChange={handleTitleChange} className={inputClass} />
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg">Description</label>
              <textarea
                value={description}
                onChange={handleDescriptionChange}
                placeholder="Add context, details, or paste raw content..."
                rows={5}
                className={`${inputClass} resize-none`}
              />
            </div>

            {/* Save button — only visible when dirty */}
            {dirty && (
              <div>
                <Button size="sm" onClick={handleSave} isDisabled={!title.trim()}>
                  Save Changes
                </Button>
              </div>
            )}

            {/* Metadata */}
            <div className="flex flex-col gap-4 pt-4 border-t border-surface-border">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-fg">Status</label>
                <select value={item.status} onChange={handleStatusChange} className={selectClass}>
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                  <option value="deferred">Deferred</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-fg">Project</label>
                <select value={item.projectId ?? ''} onChange={handleProjectChange} className={selectClass}>
                  <option value="">None</option>
                  {store.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Linked tickets */}
            {linkedTickets.length > 0 && (
              <div className="flex flex-col gap-2 pt-4 border-t border-surface-border">
                <label className="text-sm text-fg">Linked Tickets</label>
                {linkedTickets.map((t) => (
                  <div
                    key={t!.id}
                    className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface px-3 py-2"
                  >
                    <span className="text-sm text-fg flex-1">{t!.title}</span>
                    <span className="text-[10px] text-fg-subtle">{t!.priority}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Danger zone */}
            <div className="flex items-center gap-2 pt-4 border-t border-surface-border">
              {item.status === 'open' && (
                <Button size="sm" variant="ghost" onClick={handleDefer}>
                  Defer
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
InboxDetail.displayName = 'InboxDetail';
