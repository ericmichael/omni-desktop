import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect } from 'react';
import { ArrowCounterclockwise20Regular } from '@fluentui/react-icons';

import { Button, TopAppBar } from '@/renderer/ds';

import { $iceboxItems, inboxApi } from './state';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  scroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    '@media (min-width: 640px)': { paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM },
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    height: '100%',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  emptyTitle: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300 },
  emptySub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  list: { display: 'flex', flexDirection: 'column', gap: '4px' },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  cardContent: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  cardTitle: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cardDate: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  restoreIcon: { marginRight: '4px' },
});

export const IceboxList = memo(({ onBack }: { onBack: () => void }) => {
  const styles = useStyles();
  const iceboxMap = useStore($iceboxItems);
  const items = Object.values(iceboxMap).sort((a, b) => b.updatedAt - a.updatedAt);

  useEffect(() => {
    void inboxApi.fetchIceboxItems();
  }, []);

  const handleRestore = useCallback((id: string) => {
    void inboxApi.restoreFromIcebox(id);
  }, []);

  return (
    <div className={styles.root}>
      <TopAppBar title="Icebox" onBack={onBack} />

      <div className={styles.scroll}>
        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>Icebox is empty</p>
            <p className={styles.emptySub}>
              Items that sit in the inbox for 7 days without being shaped end up here.
            </p>
          </div>
        ) : (
          <div className={styles.list}>
            {items.map((item) => (
              <div key={item.id} className={styles.card}>
                <div className={styles.cardContent}>
                  <span className={styles.cardTitle}>{item.title}</span>
                  <span className={styles.cardDate}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRestore(item.id)}
                  aria-label="Restore to inbox"
                >
                  <ArrowCounterclockwise20Regular style={{ width: 14, height: 14 }} className={styles.restoreIcon} />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
IceboxList.displayName = 'IceboxList';
