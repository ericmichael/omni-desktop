import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { PiArrowSquareOutBold } from 'react-icons/pi';

import { Button, cn, ConfirmDialog, SectionLabel, Select, Textarea, TopAppBar } from '@/renderer/ds';
import { daysRemaining } from '@/lib/inbox-expiry';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId, InboxItemStatus, ShapingData } from '@/shared/types';

import { APPETITE_COLORS, APPETITE_DESCRIPTIONS, APPETITE_LABELS } from './shaping-constants';
import { ShapingForm } from './ShapingForm';
import { $inboxItems, inboxApi } from './state';

const inputClass =
  'w-full rounded-xl border border-surface-border bg-surface px-3.5 py-2.5 text-base sm:text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 transition-colors';

const STATUS_OPTIONS: { value: InboxItemStatus; label: string; dot: string }[] = [
  { value: 'open', label: 'Open', dot: 'bg-blue-400' },
  { value: 'done', label: 'Done', dot: 'bg-green-400' },
];

export const InboxDetail = memo(
  ({ itemId, onBack }: { itemId: InboxItemId; onBack: () => void }) => {
    const itemsMap = useStore($inboxItems);
    const store = useStore(persistedStoreApi.$atom);
    const item = itemsMap[itemId];

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dirty, setDirty] = useState(false);
    const [converting, setConverting] = useState(false);
    const [convertProjectId, setConvertProjectId] = useState('');

    // Sync local state when item changes externally
    useEffect(() => {
      if (!item) return;
      setTitle(item.title);
      setDescription(item.description ?? '');
      setDirty(false);
      // Pre-select project if item has one, or default to first project
      if (item.projectId) {
        setConvertProjectId(item.projectId);
      } else if (store.projects.length > 0 && !convertProjectId) {
        setConvertProjectId(store.projects[0]!.id);
      }
    }, [item?.id, item?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const handleShapeSave = useCallback(
      (shaping: ShapingData) => {
        void inboxApi.shapeItem(itemId, shaping);
      },
      [itemId]
    );

    const handleConvertToTicket = useCallback(async () => {
      if (!convertProjectId) return;
      setConverting(true);
      try {
        await inboxApi.convertToTicket(itemId, convertProjectId);
      } finally {
        setConverting(false);
      }
    }, [itemId, convertProjectId]);

    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const handleOpenDeleteConfirm = useCallback(() => setDeleteConfirmOpen(true), []);
    const handleCloseDeleteConfirm = useCallback(() => setDeleteConfirmOpen(false), []);
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

    const days = item.status === 'open' ? daysRemaining(item, Date.now()) : null;
    const isShaped = !!item.shaping;

    return (
      <div className="flex flex-col w-full h-full">
        <TopAppBar
          title={item.title}
          onBack={onBack}
          actions={
            <span className="text-xs text-fg-subtle hidden sm:inline">
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
          }
        />

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 max-w-2xl px-4 sm:px-6 py-4 sm:py-5">
            {/* Expiry countdown */}
            {days !== null && !isShaped && (
              <div
                className={cn(
                  'flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium',
                  days <= 1 ? 'bg-amber-500/10 text-amber-400' : 'bg-surface-raised/50 text-fg-subtle'
                )}
              >
                {days <= 0
                  ? 'Expiring today — shape or it moves to icebox'
                  : `${days} day${days !== 1 ? 's' : ''} until this moves to icebox`}
              </div>
            )}

            {/* Title & Description card */}
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <input
                value={title}
                onChange={handleTitleChange}
                placeholder="Title"
                className={inputClass}
              />
              <Textarea
                value={description}
                onChange={handleDescriptionChange}
                placeholder="Add context, details, or paste raw content..."
                rows={4}
                className="rounded-xl"
              />
              {dirty && (
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSave} isDisabled={!title.trim()}>
                    Save
                  </Button>
                </div>
              )}
            </div>

            {/* Shaping */}
            {item.status !== 'done' && !isShaped && (
              <ShapingForm onSave={handleShapeSave} />
            )}

            {/* Shaped — read-only display */}
            {isShaped && (
              <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/50 p-4 border border-accent-500/20">
                <SectionLabel>Shaped</SectionLabel>
                <div className="flex flex-col gap-2.5">
                  <div>
                    <span className="text-xs font-medium text-fg-muted">Done looks like</span>
                    <p className="text-sm text-fg mt-0.5">{item.shaping!.doneLooksLike}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-fg-muted">Appetite</span>
                    <div className="mt-0.5">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', APPETITE_COLORS[item.shaping!.appetite])}>
                        {APPETITE_LABELS[item.shaping!.appetite]} — {APPETITE_DESCRIPTIONS[item.shaping!.appetite]}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-fg-muted">Out of scope</span>
                    <p className="text-sm text-fg mt-0.5">{item.shaping!.outOfScope}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Convert to ticket — only when shaped */}
            {isShaped && item.status !== 'done' && (
              <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
                <SectionLabel>Convert to Ticket</SectionLabel>
                <Select
                  value={convertProjectId}
                  onChange={(e) => setConvertProjectId(e.target.value)}
                  className="w-full rounded-xl"
                >
                  {store.projects.length === 0 && <option value="">No projects</option>}
                  {store.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  onClick={handleConvertToTicket}
                  isDisabled={converting || !convertProjectId}
                  className="w-full sm:w-auto justify-center"
                >
                  <PiArrowSquareOutBold size={14} className="mr-1" />
                  Send to Backlog
                </Button>
              </div>
            )}

            {/* Status chips */}
            <div className="flex flex-col gap-2 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <SectionLabel>Status</SectionLabel>
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

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2">
              <Button size="sm" variant="destructive" onClick={handleOpenDeleteConfirm} className="w-full sm:w-auto justify-center">
                Delete
              </Button>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={deleteConfirmOpen}
          onClose={handleCloseDeleteConfirm}
          onConfirm={handleDelete}
          title="Delete inbox item?"
          description="This item will be permanently removed."
          confirmLabel="Delete"
          destructive
        />
      </div>
    );
  }
);
InboxDetail.displayName = 'InboxDetail';
