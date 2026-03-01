import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { PiPlusBold, PiXBold } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId } from '@/shared/types';

import { $codeTabStatuses, codeApi } from './state';

type CodeTabBarProps = {
  tabs: CodeTab[];
  activeTabId: CodeTabId | null;
};

const TabItem = memo(
  ({
    tab,
    isActive,
    projectLabel,
    isRunning,
    onSelect,
    onClose,
  }: {
    tab: CodeTab;
    isActive: boolean;
    projectLabel: string;
    isRunning: boolean;
    onSelect: (id: CodeTabId) => void;
    onClose: (id: CodeTabId) => void;
  }) => {
    const handleSelect = useCallback(() => {
      onSelect(tab.id);
    }, [tab.id, onSelect]);

    const handleClose = useCallback(() => {
      onClose(tab.id);
    }, [tab.id, onClose]);

    return (
      <button
        onClick={handleSelect}
        className={cn(
          'group flex items-center gap-2 px-3 py-1.5 text-sm rounded-t-md border-b-2 transition-colors min-w-0 max-w-[200px] cursor-pointer',
          isActive
            ? 'border-accent-500 bg-surface text-fg'
            : 'border-transparent text-fg-muted hover:text-fg hover:bg-surface-overlay'
        )}
      >
        {isRunning && <div className="size-2 shrink-0 rounded-full bg-green-400" />}
        <span className="truncate">{projectLabel}</span>
        <IconButton
          aria-label="Close tab"
          icon={<PiXBold size={12} />}
          size="sm"
          onClick={handleClose}
          className={cn(
            'shrink-0 !size-5',
            isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
          )}
        />
      </button>
    );
  }
);
TabItem.displayName = 'TabItem';

export const CodeTabBar = memo(({ tabs, activeTabId }: CodeTabBarProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const allStatuses = useStore($codeTabStatuses);

  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of store.fleetProjects) {
      m.set(p.id, p.label);
    }
    return m;
  }, [store.fleetProjects]);

  const handleSelect = useCallback((id: CodeTabId) => {
    codeApi.setActiveTab(id);
  }, []);

  const handleClose = useCallback((id: CodeTabId) => {
    codeApi.removeTab(id);
  }, []);

  const handleAdd = useCallback(() => {
    codeApi.addTab();
  }, []);

  return (
    <div className="flex items-end border-b border-surface-border bg-surface-raised px-2 pt-1 gap-0.5 overflow-x-auto shrink-0">
      {tabs.map((tab) => {
        const status = allStatuses[tab.id];
        const isRunning = status?.type === 'running';
        const projectLabel = tab.projectId ? (projectMap.get(tab.projectId) ?? 'Unknown') : 'New Tab';
        return (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            projectLabel={projectLabel}
            isRunning={isRunning}
            onSelect={handleSelect}
            onClose={handleClose}
          />
        );
      })}
      <IconButton
        aria-label="New tab"
        icon={<PiPlusBold size={14} />}
        size="sm"
        onClick={handleAdd}
        className="shrink-0 ml-1 mb-0.5"
      />
    </div>
  );
});
CodeTabBar.displayName = 'CodeTabBar';
