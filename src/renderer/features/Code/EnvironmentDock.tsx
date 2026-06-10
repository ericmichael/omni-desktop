import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { memo, useCallback } from 'react';

import type { AppDescriptor, AppId } from '@/shared/app-registry';

import { AppIcon } from './AppIcon';

export { ICON_MAP } from './AppIcon';
export type { AppId };

type EnvironmentDockProps = {
  apps: AppDescriptor[];
  activeAppId: AppId;
  onSelect: (id: AppId) => void;
  sandboxUrls?: Record<string, string | undefined>;
  isGlass?: boolean;
};

const useStyles = makeStyles({
  dock: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalXXS,
    marginLeft: tokens.spacingHorizontalMNudge,
    marginRight: tokens.spacingHorizontalMNudge,
    marginBottom: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalSNudge,
    paddingLeft: tokens.spacingHorizontalSNudge,
    paddingRight: tokens.spacingHorizontalSNudge,
    paddingTop: '5px',
    paddingBottom: '5px',
    // Match the code deck column border: same stroke token + radius.
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 1px 12px rgba(0,0,0,0.10), 0 0 0 1px ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    /* Lift the floating pill above the home indicator instead of growing it:
       the inset goes in the margin so the dock keeps its shape. */
    '@media (max-width: 639px)': {
      marginBottom: `calc(${tokens.spacingVerticalS} + var(--safe-area-bottom, env(safe-area-inset-bottom, 0px)))`,
    },
  },
  dockGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 18%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    boxShadow: `0 1px 0 0 color-mix(in srgb, white 14%, transparent) inset, 0 0 0 1px color-mix(in srgb, ${tokens.colorNeutralStroke1} 40%, transparent), 0 12px 32px -12px rgba(0, 0, 0, 0.35)`,
  },
  item: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '5px',
    paddingBottom: tokens.spacingVerticalSNudge,
    borderRadius: '10px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color, background-color, transform, box-shadow',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    /* Hover effects only where hover exists — on touch the emulated :hover
       sticks after a tap, leaving the last-used icon raised and tinted. */
    '@media (hover: hover)': {
      ':hover': {
        backgroundColor: tokens.colorSubtleBackgroundHover,
        color: tokens.colorNeutralForeground1,
        transform: 'translateY(-1px) scale(1.06)',
      },
    },
    ':active': {
      transform: 'translateY(0) scale(0.97)',
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  itemActive: {
    color: tokens.colorBrandForeground1,
    ':hover': {
      color: tokens.colorBrandForeground1,
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

export const EnvironmentDock = memo(({ apps, activeAppId, onSelect, sandboxUrls, isGlass }: EnvironmentDockProps) => {
  const styles = useStyles();

  const handleAppClick = useCallback(
    (id: AppId) => {
      onSelect(id);
    },
    [onSelect]
  );

  return (
    <div className={mergeClasses(styles.dock, isGlass && styles.dockGlass)}>
      {apps.map((app) => {
        const isActive = activeAppId === app.id;
        const isAvailable = app.scope === 'sandbox' ? !!sandboxUrls?.[app.sandboxUrlKey!] : true;

        if (app.scope === 'sandbox' && !isAvailable) {
          return null;
        }

        return (
          <button
            key={app.id}
            type="button"
            className={mergeClasses(styles.item, isActive && styles.itemActive)}
            onClick={() => handleAppClick(app.id)}
            aria-label={app.label}
            title={app.label}
          >
            <AppIcon icon={app.icon} size={20} className={styles.icon} />
            <span className={styles.label}>{app.label}</span>
            <span className={mergeClasses(styles.dot, !isActive && styles.dotHidden)} />
          </button>
        );
      })}
    </div>
  );
});
EnvironmentDock.displayName = 'EnvironmentDock';
