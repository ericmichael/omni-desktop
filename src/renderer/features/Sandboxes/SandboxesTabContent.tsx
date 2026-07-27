import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { PageHeader } from '@/renderer/ds';
import { HealthPane } from '@/renderer/features/Sandboxes/HealthPane';
import { ProfilesPane } from '@/renderer/features/Sandboxes/ProfilesPane';
import { RunningPane } from '@/renderer/features/Sandboxes/RunningPane';
import { $sandboxesSelectedPane, type SandboxesPane } from '@/renderer/features/Sandboxes/state';
import { $glassEnabled } from '@/renderer/theme/use-glass';

/**
 * The tab's fixed master list — three nodes mapping to detail panes
 * (docs/sandboxes-tab-plan.md, Decision 2). Fixed, not data-driven: the
 * data lives in the panes.
 */
const PANES: { id: SandboxesPane; title: string; meta: string }[] = [
  { id: 'health', title: 'Health', meta: 'Substrate status and machines' },
  { id: 'profiles', title: 'Profiles', meta: 'Discovered sandbox profiles' },
  { id: 'running', title: 'Running', meta: 'Containers and cleanup' },
];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  listPane: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    '@media (min-width: 640px)': {
      width: '320px',
      flexShrink: 0,
      borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  listPaneGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  detailPane: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  detailPaneGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
  },
  rowSelected: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  rowTitle: {
    fontWeight: tokens.fontWeightRegular,
    fontSize: tokens.fontSizeBase300,
  },
  rowMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  detailBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
});

const selectPane = (pane: SandboxesPane): void => {
  $sandboxesSelectedPane.set(pane);
};

export const SandboxesTabContent = memo(() => {
  const styles = useStyles();
  const selectedPane = useStore($sandboxesSelectedPane);
  const isGlass = useStore($glassEnabled);

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={mergeClasses(styles.listPane, isGlass && styles.listPaneGlass)}>
        <PageHeader title="Sandboxes" />
        <div className={styles.list}>
          {PANES.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className={mergeClasses(styles.row, selectedPane === pane.id && styles.rowSelected)}
              onClick={selectPane.bind(null, pane.id)}
            >
              <span className={styles.rowTitle}>{pane.title}</span>
              <span className={styles.rowMeta}>{pane.meta}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={mergeClasses(styles.detailPane, isGlass && styles.detailPaneGlass)}>
        <div className={styles.detailBody}>
          {/* Only the active pane mounts — pane-local pollers (containers,
              wsl:status) start on mount and clear on pane-switch. */}
          {selectedPane === 'health' && <HealthPane />}
          {selectedPane === 'profiles' && <ProfilesPane />}
          {selectedPane === 'running' && <RunningPane />}
        </div>
      </div>
    </div>
  );
});
SandboxesTabContent.displayName = 'SandboxesTabContent';
