import { memo, useCallback } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Chat20Regular, Code20Regular, Desktop20Regular, Globe20Regular, WindowConsole20Regular } from '@fluentui/react-icons';

export type DockPane = 'none' | 'code' | 'vnc' | 'preview' | 'terminal';

type EnvironmentDockProps = {
  activePane: DockPane;
  onSelect: (pane: DockPane) => void;
  codeAvailable: boolean;
  desktopAvailable: boolean;
};

const useStyles = makeStyles({
  dock: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    marginLeft: '10px',
    marginRight: '10px',
    marginBottom: '8px',
    marginTop: '6px',
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '5px',
    paddingBottom: '5px',
    borderRadius: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 1px 12px rgba(0,0,0,0.10), 0 0 0 1px ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  separator: {
    width: '1px',
    height: '20px',
    marginLeft: '4px',
    marginRight: '4px',
    backgroundColor: tokens.colorNeutralStroke2,
    flexShrink: 0,
  },
  item: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '5px',
    paddingBottom: '6px',
    borderRadius: '10px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color, background-color, transform, box-shadow',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
      transform: 'translateY(-1px) scale(1.06)',
    },
    ':active': {
      transform: 'translateY(0) scale(0.97)',
    },
  },
  itemActive: {
    color: tokens.colorBrandForeground1,
    ':hover': {
      color: tokens.colorBrandForeground1,
    },
  },
  itemDisabled: {
    opacity: 0.25,
    cursor: 'default',
    ':hover': {
      backgroundColor: 'transparent',
      color: tokens.colorNeutralForeground3,
      transform: 'none',
    },
    ':active': {
      transform: 'none',
    },
  },
  label: {
    fontSize: '10px',
    fontWeight: tokens.fontWeightMedium,
    lineHeight: 1,
    letterSpacing: '0.01em',
  },
  dot: {
    position: 'absolute',
    bottom: '0px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '4px',
    height: '4px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandForeground1,
    transitionProperty: 'opacity, transform',
    transitionDuration: '200ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  dotHidden: {
    opacity: 0,
    transform: 'translateX(-50%) scale(0)',
  },
  icon: {
    transitionProperty: 'transform',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
});

const PANE_ITEMS: { pane: DockPane; label: string; Icon: typeof Code20Regular; availabilityKey?: keyof Pick<EnvironmentDockProps, 'codeAvailable' | 'desktopAvailable'> }[] = [
  { pane: 'none', label: 'Chat', Icon: Chat20Regular },
  { pane: 'code', label: 'Code', Icon: Code20Regular, availabilityKey: 'codeAvailable' },
  { pane: 'vnc', label: 'Desktop', Icon: Desktop20Regular, availabilityKey: 'desktopAvailable' },
  { pane: 'preview', label: 'Browser', Icon: Globe20Regular },
];

export const EnvironmentDock = memo(({ activePane, onSelect, codeAvailable, desktopAvailable }: EnvironmentDockProps) => {
  const styles = useStyles();
  const availability: Record<string, boolean> = { codeAvailable, desktopAvailable };

  const handlePaneClick = useCallback(
    (pane: DockPane, isAvailable: boolean) => {
      if (!isAvailable) return;
      onSelect(pane === activePane && pane !== 'none' ? 'none' : pane);
    },
    [activePane, onSelect]
  );

  return (
    <div className={styles.dock}>
      {PANE_ITEMS.map(({ pane, label, Icon, availabilityKey }) => {
        const isActive = activePane === pane;
        const isAvailable = availabilityKey ? !!availability[availabilityKey] : true;
        return (
          <button
            key={pane}
            type="button"
            className={mergeClasses(
              styles.item,
              isActive && styles.itemActive,
              !isAvailable && styles.itemDisabled,
            )}
            onClick={() => handlePaneClick(pane, isAvailable)}
            disabled={!isAvailable}
            aria-label={label}
            title={!isAvailable ? `${label} (unavailable)` : label}
          >
            <Icon className={styles.icon} style={{ width: 20, height: 20 }} />
            <span className={styles.label}>{label}</span>
            <span className={mergeClasses(styles.dot, !isActive && styles.dotHidden)} />
          </button>
        );
      })}

      <div className={styles.separator} />

      <button
        type="button"
        className={mergeClasses(styles.item, activePane === 'terminal' && styles.itemActive)}
        onClick={() => handlePaneClick('terminal', true)}
        aria-label="Terminal"
        title="Terminal"
      >
        <WindowConsole20Regular className={styles.icon} style={{ width: 20, height: 20 }} />
        <span className={styles.label}>Terminal</span>
        <span className={mergeClasses(styles.dot, activePane !== 'terminal' && styles.dotHidden)} />
      </button>
    </div>
  );
});
EnvironmentDock.displayName = 'EnvironmentDock';
