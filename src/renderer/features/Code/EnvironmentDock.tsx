import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Chat20Regular, Code20Regular, Desktop20Regular, Globe20Regular, WindowConsole20Regular } from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

export type WorkspaceApp = 'chat' | 'code' | 'desktop' | 'browser' | 'terminal';

type EnvironmentDockProps = {
  activeApp: WorkspaceApp;
  onSelect: (app: WorkspaceApp) => void;
  codeAvailable: boolean;
  desktopAvailable: boolean;
  isGlass?: boolean;
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
  dockGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 18%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    boxShadow: `0 1px 0 0 color-mix(in srgb, white 14%, transparent) inset, 0 0 0 1px color-mix(in srgb, ${tokens.colorNeutralStroke1} 40%, transparent), 0 12px 32px -12px rgba(0, 0, 0, 0.35)`,
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

const APP_ITEMS: { app: WorkspaceApp; label: string; Icon: typeof Code20Regular; availabilityKey?: keyof Pick<EnvironmentDockProps, 'codeAvailable' | 'desktopAvailable'> }[] = [
  { app: 'chat', label: 'Chat', Icon: Chat20Regular },
  { app: 'code', label: 'Code', Icon: Code20Regular, availabilityKey: 'codeAvailable' },
  { app: 'desktop', label: 'Desktop', Icon: Desktop20Regular, availabilityKey: 'desktopAvailable' },
  { app: 'browser', label: 'Browser', Icon: Globe20Regular },
  { app: 'terminal', label: 'Terminal', Icon: WindowConsole20Regular },
];

export const EnvironmentDock = memo(({ activeApp, onSelect, codeAvailable, desktopAvailable, isGlass }: EnvironmentDockProps) => {
  const styles = useStyles();
  const availability: Record<string, boolean> = { codeAvailable, desktopAvailable };

  const handleAppClick = useCallback(
    (app: WorkspaceApp, isAvailable: boolean) => {
      if (!isAvailable) {
return;
}
      onSelect(app);
    },
    [onSelect]
  );

  return (
    <div className={mergeClasses(styles.dock, isGlass && styles.dockGlass)}>
      {APP_ITEMS.map(({ app, label, Icon, availabilityKey }) => {
        const isActive = activeApp === app;
        const isAvailable = availabilityKey ? !!availability[availabilityKey] : true;
        return (
          <button
            key={app}
            type="button"
            className={mergeClasses(
              styles.item,
              isActive && styles.itemActive,
              !isAvailable && styles.itemDisabled,
            )}
            onClick={() => handleAppClick(app, isAvailable)}
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
    </div>
  );
});
EnvironmentDock.displayName = 'EnvironmentDock';
