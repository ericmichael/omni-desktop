import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, Dismiss16Regular, Globe16Regular, Pin16Regular, PinOff16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useMemo } from 'react';

import { fallbackTitle } from '@/lib/url';
import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserTab, BrowserTabId, BrowserTabset } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'stretch',
    minHeight: '34px',
    paddingLeft: '4px',
    paddingRight: '4px',
    gap: '2px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
  },
  rootGlass: {
    backgroundColor: 'transparent',
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: '10px',
    paddingRight: '6px',
    marginTop: '4px',
    minWidth: '120px',
    maxWidth: '220px',
    height: '26px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    color: tokens.colorNeutralForeground2,
    backgroundColor: 'transparent',
    transitionProperty: 'background-color, color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  tabActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderBottomColor: 'transparent',
  },
  tabPinned: {
    minWidth: '38px',
    maxWidth: '38px',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  tabDragging: { opacity: 0.6 },
  favicon: { width: '14px', height: '14px', flexShrink: 0 },
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase200,
  },
  close: {
    display: 'inline-flex',
    width: '18px',
    height: '18px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  newTab: {
    display: 'inline-flex',
    width: '26px',
    height: '26px',
    marginTop: '4px',
    marginLeft: '4px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
});

type TabItemProps = {
  tab: BrowserTab;
  active: boolean;
  onSelect: (id: BrowserTabId) => void;
  onClose: (id: BrowserTabId) => void;
  onPinToggle: (id: BrowserTabId, pinned: boolean) => void;
  onDuplicate: (id: BrowserTabId) => void;
};

const TabItem = memo(({ tab, active, onSelect, onClose, onPinToggle, onDuplicate }: TabItemProps) => {
  const styles = useStyles();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const title = tab.title ?? fallbackTitle(tab.url);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle-click closes — handled in mouseDown because the browser's
      // default middle-click (autoscroll) fires on mouseup.
      if (e.button === 1) {
        e.preventDefault();
        onClose(tab.id);
      }
    },
    [onClose, tab.id]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id]
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={mergeClasses(
        styles.tab,
        active && styles.tabActive,
        tab.pinned && styles.tabPinned,
        isDragging && styles.tabDragging
      )}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(tab.id)}
      onMouseDown={handleMouseDown}
      role="tab"
      aria-selected={active}
      title={title}
    >
      {tab.favicon ? (
        <img src={tab.favicon} alt="" className={styles.favicon} />
      ) : (
        <Globe16Regular className={styles.favicon} />
      )}
      {!tab.pinned && <span className={styles.title}>{title}</span>}
      <Menu positioning={{ position: 'below', align: 'start' }}>
        <MenuTrigger>
          {/*
            A context-menu trigger hidden behind the right-click. The button
            is invisible — right-click anywhere on the tab opens it via the
            ctx handler below.
          */}
          <span style={{ display: 'none' }} aria-hidden />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => onDuplicate(tab.id)}>Duplicate tab</MenuItem>
            <MenuItem
              icon={tab.pinned ? <PinOff16Regular /> : <Pin16Regular />}
              onClick={() => onPinToggle(tab.id, !tab.pinned)}
            >
              {tab.pinned ? 'Unpin tab' : 'Pin tab'}
            </MenuItem>
            <MenuItem onClick={() => onClose(tab.id)}>Close tab</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {!tab.pinned && (
        <button type="button" className={styles.close} onClick={handleClose} aria-label={`Close ${title}`}>
          <Dismiss16Regular />
        </button>
      )}
    </div>
  );
});
TabItem.displayName = 'TabItem';

export const TabStrip = memo(
  ({
    tabset,
    isGlass,
    onNewTab,
  }: {
    tabset: BrowserTabset;
    isGlass?: boolean;
    onNewTab: () => void;
  }) => {
    const styles = useStyles();
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

    // Pinned tabs render first, in their own stable order. Drag reorder
    // operates across the whole list but we sort so pinned stay leftmost.
    const orderedTabs = useMemo(() => {
      const pinned = tabset.tabs.filter((t) => t.pinned);
      const rest = tabset.tabs.filter((t) => !t.pinned);
      return [...pinned, ...rest];
    }, [tabset.tabs]);

    const handleSelect = useCallback(
      (id: BrowserTabId) => {
        void browserApi.activateTab(tabset.id, id);
      },
      [tabset.id]
    );

    const handleClose = useCallback(
      (id: BrowserTabId) => {
        void browserApi.closeTab(tabset.id, id);
      },
      [tabset.id]
    );

    const handlePinToggle = useCallback(
      (id: BrowserTabId, pinned: boolean) => {
        void browserApi.pinTab(tabset.id, id, pinned);
      },
      [tabset.id]
    );

    const handleDuplicate = useCallback(
      (id: BrowserTabId) => {
        void browserApi.duplicateTab(tabset.id, id);
      },
      [tabset.id]
    );

    const handleDragEnd = useCallback(
      (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) {
return;
}
        const ids = orderedTabs.map((t) => t.id);
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) {
return;
}
        const next = arrayMove(ids, oldIndex, newIndex);
        void browserApi.reorderTabs(tabset.id, next);
      },
      [orderedTabs, tabset.id]
    );

    return (
      <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)} role="tablist">
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedTabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {orderedTabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === tabset.activeTabId}
                onSelect={handleSelect}
                onClose={handleClose}
                onPinToggle={handlePinToggle}
                onDuplicate={handleDuplicate}
              />
            ))}
          </SortableContext>
        </DndContext>
        <button type="button" className={styles.newTab} aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNewTab}>
          <Add20Regular style={{ width: 14, height: 14 }} />
        </button>
      </div>
    );
  }
);
TabStrip.displayName = 'TabStrip';
