import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiArrowLeftBold } from 'react-icons/pi';

import { Button, IconButton, cn } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId, InboxItemStatus } from '@/shared/types';

import { $inboxItems, inboxApi } from './state';

const inputClass =
  'w-full rounded-xl border border-surface-border bg-surface px-3.5 py-2.5 text-base sm:text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 transition-colors';

const STATUS_OPTIONS: { value: InboxItemStatus; label: string; dot: string }[] = [
  { value: 'open', label: 'Open', dot: 'bg-blue-400' },
  { value: 'done', label: 'Done', dot: 'bg-green-400' },
  { value: 'deferred', label: 'Deferred', dot: 'bg-fg-muted/50' },
];

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
      (status: InboxItemStatus) => {
        void inboxApi.updateItem(itemId, { status });
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
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-surface-border shrink-0">
          <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={onBack} />
          <span className="text-sm font-semibold text-fg truncate flex-1">{item.title}</span>
          <span className="text-xs text-fg-subtle shrink-0 hidden sm:inline">
            {new Date(item.createdAt).toLocaleDateString()}
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 max-w-2xl px-4 sm:px-6 py-4 sm:py-5">
            {/* Title & Description card */}
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <input
                value={title}
                onChange={handleTitleChange}
                placeholder="Title"
                className={inputClass}
              />
              <textarea
                value={description}
                onChange={handleDescriptionChange}
                placeholder="Add context, details, or paste raw content..."
                rows={4}
                className={`${inputClass} resize-none`}
              />
              {dirty && (
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSave} isDisabled={!title.trim()}>
                    Save
                  </Button>
                </div>
              )}
            </div>

            {/* Status chips */}
            <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">Status</span>
              <div className="flex items-center gap-2">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleStatusChange(opt.value)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                      item.status === opt.value
                        ? 'bg-accent-600/20 text-accent-400'
                        : 'bg-surface-overlay text-fg-muted hover:text-fg'
                    )}
                  >
                    <span className={cn('size-2 rounded-full', opt.dot)} />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Project */}
            <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">Project</span>
              <select
                value={item.projectId ?? ''}
                onChange={handleProjectChange}
                className="w-full rounded-xl border border-surface-border bg-surface px-3.5 py-2.5 text-base sm:text-sm text-fg focus:outline-none focus:border-accent-500 transition-colors"
              >
                <option value="">None</option>
                {store.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Linked tickets */}
            {linkedTickets.length > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
                <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">Linked Tickets</span>
                <div className="flex flex-col gap-1.5">
                  {linkedTickets.map((t) => (
                    <div
                      key={t!.id}
                      className="flex items-center gap-2 rounded-xl bg-surface px-3.5 py-2.5"
                    >
                      <span className="text-sm text-fg flex-1 truncate">{t!.title}</span>
                      <span className="text-[10px] text-fg-subtle shrink-0">{t!.priority}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2">
              {item.status === 'open' && (
                <Button size="sm" variant="ghost" onClick={handleDefer} className="w-full sm:w-auto justify-center">
                  Defer
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={handleDelete} className="w-full sm:w-auto justify-center">
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
