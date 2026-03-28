import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { cn } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetLayoutMode } from '@/shared/types';

import { FleetDeck } from './FleetDeck';
import { FleetFocusView } from './FleetFocusView';
import { FleetProjectDetail } from './FleetProjectDetail';
import { FleetSidebar } from './FleetSidebar';
import { $fleetView, fleetApi } from './state';

/** Normalize legacy 'kanban' value from persisted store to the new model. */
const normalizeLayoutMode = (raw: string | undefined): FleetLayoutMode =>
  raw === 'focus' ? 'focus' : 'deck';

type SegmentOption<T extends string> = { key: T; label: string };

const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (key: T) => void;
  disabled?: boolean;
}) => (
  <div
    className={cn(
      'flex items-center gap-0.5 rounded-md bg-surface-overlay p-0.5 transition-opacity',
      disabled && 'opacity-40 pointer-events-none'
    )}
  >
    {options.map((o) => (
      <button
        key={o.key}
        type="button"
        disabled={disabled}
        onClick={() => onChange(o.key)}
        className={cn(
          'px-2 py-1 text-[11px] rounded-sm transition-colors',
          value === o.key ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-border/40'
        )}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const VIEW_OPTIONS: SegmentOption<'board' | 'workspace'>[] = [
  { key: 'board', label: 'Board' },
  { key: 'workspace', label: 'Workspace' },
];

const WORKSPACE_OPTIONS: SegmentOption<FleetLayoutMode>[] = [
  { key: 'deck', label: 'Deck' },
  { key: 'focus', label: 'Focus' },
];

const ModeToggle = memo(
  ({ layoutMode, boardOpen }: { layoutMode: FleetLayoutMode; boardOpen: boolean }) => {
    const handleViewChange = useCallback(
      (key: 'board' | 'workspace') => {
        persistedStoreApi.setKey('fleetBoardOpen', key === 'board');
      },
      []
    );

    const handleWorkspaceChange = useCallback(
      (key: FleetLayoutMode) => {
        fleetApi.setFleetLayoutMode(key);
        if (boardOpen) persistedStoreApi.setKey('fleetBoardOpen', false);
      },
      [boardOpen]
    );

    return (
      <div className="flex items-center gap-2">
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={boardOpen ? 'board' : 'workspace'}
          onChange={handleViewChange}
        />
        <SegmentedControl
          options={WORKSPACE_OPTIONS}
          value={layoutMode}
          onChange={handleWorkspaceChange}
          disabled={boardOpen}
        />
      </div>
    );
  }
);
ModeToggle.displayName = 'ModeToggle';

const FleetContent = memo(() => {
  const view = useStore($fleetView);
  const store = useStore(persistedStoreApi.$atom);
  const layoutMode = normalizeLayoutMode(store.fleetLayoutMode);
  const boardOpen = store.fleetBoardOpen ?? false;

  if (boardOpen) {
    if (view.type === 'project') {
      return <FleetProjectDetail projectId={view.projectId} />;
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full">
        <p className="text-fg-muted text-sm">Select a project to get started</p>
        <p className="text-fg-subtle text-xs">Or create a new project from the sidebar</p>
      </div>
    );
  }

  if (layoutMode === 'focus') {
    return <FleetFocusView />;
  }

  return <FleetDeck />;
});
FleetContent.displayName = 'FleetContent';

export const Fleet = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const layoutMode = normalizeLayoutMode(store.fleetLayoutMode);
  const boardOpen = store.fleetBoardOpen ?? false;
  const showSidebar = boardOpen || layoutMode === 'focus';

  return (
    <div className="flex w-full h-full">
      {showSidebar && <FleetSidebar />}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar with mode toggle */}
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-surface-border shrink-0">
          <div className="flex-1" />
          <ModeToggle layoutMode={layoutMode} boardOpen={boardOpen} />
        </div>
        <div className="flex-1 min-h-0">
          <FleetContent />
        </div>
      </div>
    </div>
  );
});
Fleet.displayName = 'Fleet';
