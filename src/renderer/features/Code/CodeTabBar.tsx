import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { Add20Regular, Dismiss20Regular } from '@fluentui/react-icons';

import { IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId } from '@/shared/types';

import { $codeTabStatuses, codeApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'flex-end',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '4px',
    gap: '2px',
    overflowX: 'auto',
    flexShrink: 0,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    fontSize: tokens.fontSizeBase300,
    borderTopLeftRadius: tokens.borderRadiusMedium,
    borderTopRightRadius: tokens.borderRadiusMedium,
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid',
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    minWidth: 0,
    maxWidth: '200px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  tabInactive: {
    borderBottomColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    ':hover': { color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  runningDot: { width: '8px', height: '8px', flexShrink: 0, borderRadius: '9999px', backgroundColor: tokens.colorPaletteGreenForeground1 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  closeBtn: { flexShrink: 0, width: '20px !important', height: '20px !important' },
  closeBtnActive: { opacity: 0.7, ':hover': { opacity: 1 } },
  closeBtnInactive: { opacity: 0 },
  addBtn: { flexShrink: 0, marginLeft: '4px', marginBottom: '2px' },
});

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
    const styles = useStyles();
    const handleSelect = useCallback(() => {
      onSelect(tab.id);
    }, [tab.id, onSelect]);

    const handleClose = useCallback(() => {
      onClose(tab.id);
    }, [tab.id, onClose]);

    return (
      <button
        onClick={handleSelect}
        className={mergeClasses(styles.tab, isActive ? styles.tabActive : styles.tabInactive)}
      >
        {isRunning && <div className={styles.runningDot} />}
        <span className={styles.truncate}>{projectLabel}</span>
        <IconButton
          aria-label="Close tab"
          icon={<Dismiss20Regular style={{ width: 12, height: 12 }} />}
          size="sm"
          onClick={handleClose}
          className={mergeClasses(styles.closeBtn, isActive ? styles.closeBtnActive : styles.closeBtnInactive)}
        />
      </button>
    );
  }
);
TabItem.displayName = 'TabItem';

export const CodeTabBar = memo(({ tabs, activeTabId }: CodeTabBarProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const allStatuses = useStore($codeTabStatuses);

  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of store.projects) {
      m.set(p.id, p.label);
    }
    return m;
  }, [store.projects]);

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
    <div className={styles.root}>
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
        icon={<Add20Regular style={{ width: 14, height: 14 }} />}
        size="sm"
        onClick={handleAdd}
        className={styles.addBtn}
      />
    </div>
  );
});
CodeTabBar.displayName = 'CodeTabBar';
