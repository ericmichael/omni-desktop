import { Skeleton as FluentSkeleton, SkeletonItem, makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
});

/** Skeleton for a list of items (inbox, file list, ticket list). */
export const ListSkeleton = ({ rows = 5 }: { rows?: number }) => {
  const styles = useStyles();
  return (
    <FluentSkeleton className={styles.root} style={{ gap: 12, padding: 16 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row}>
          <SkeletonItem shape="circle" size={32} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SkeletonItem size={16} style={{ width: `${60 + (i % 3) * 15}%` }} />
            <SkeletonItem size={12} style={{ width: `${40 + (i % 2) * 20}%` }} />
          </div>
        </div>
      ))}
    </FluentSkeleton>
  );
};

/** Skeleton for a settings/form view (label + input pairs). */
export const FormSkeleton = ({ fields = 4 }: { fields?: number }) => {
  const styles = useStyles();
  return (
    <FluentSkeleton className={styles.root} style={{ gap: 20, padding: 16 }}>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className={styles.formRow}>
          <SkeletonItem size={12} style={{ width: `${60 + (i % 3) * 10}px` }} />
          <SkeletonItem size={32} style={{ width: '100%' }} />
        </div>
      ))}
    </FluentSkeleton>
  );
};

/** Skeleton for a card grid (kanban columns, dashboard cards). */
export const CardSkeleton = ({ cards = 3 }: { cards?: number }) => {
  const styles = useStyles();
  return (
    <FluentSkeleton className={styles.root} style={{ gap: 12, padding: 16 }}>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8 }}>
          <SkeletonItem size={16} style={{ width: `${50 + (i % 3) * 15}%` }} />
          <SkeletonItem size={12} style={{ width: `${70 + (i % 2) * 15}%` }} />
          <SkeletonItem size={12} style={{ width: '40%' }} />
        </div>
      ))}
    </FluentSkeleton>
  );
};
