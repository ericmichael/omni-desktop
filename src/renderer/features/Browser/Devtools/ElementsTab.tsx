/**
 * Elements tab — renders the accessibility tree from `app:snapshot` as a
 * collapsible outline. Each row shows role + name + optional value. Useful
 * for understanding what `app_snapshot` refs correspond to while iterating
 * on an automation script.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular, ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId, AxNode } from '@/shared/app-control-types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '28px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  spacer: { flex: '1 1 0' },
  iconBtn: {
    display: 'inline-flex',
    width: '22px',
    height: '22px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  tree: {
    flex: '1 1 0',
    minHeight: 0,
    overflow: 'auto',
    padding: '4px 0',
    fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, monospace",
    fontSize: '12px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 4px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  caret: {
    display: 'inline-flex',
    width: '14px',
    height: '14px',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  ref: {
    flex: '0 0 auto',
    color: tokens.colorNeutralForeground4,
    fontSize: '10px',
  },
  role: { color: tokens.colorPaletteBlueForeground2, fontWeight: tokens.fontWeightSemibold },
  name: { color: tokens.colorNeutralForeground1, marginLeft: '8px' },
  value: { color: tokens.colorNeutralForeground2, marginLeft: '8px', fontStyle: 'italic' },
  loading: { padding: '16px', textAlign: 'center', color: tokens.colorNeutralForeground4 },
});

const Node = memo(({ node, depth }: { node: AxNode; depth: number }) => {
  const styles = useStyles();
  const hasChildren = !!node.children && node.children.length > 0;
  const [open, setOpen] = useState(depth < 2);

  return (
    <>
      <div
        className={styles.row}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={hasChildren ? () => setOpen((v) => !v) : undefined}
      >
        <span className={styles.caret}>
          {hasChildren ? open ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : null}
        </span>
        <span className={styles.ref}>{node.ref}</span>
        <span className={styles.role}>{node.role}</span>
        {node.name && <span className={styles.name}>“{node.name}”</span>}
        {node.value && <span className={styles.value}>= {node.value}</span>}
      </div>
      {hasChildren && open && node.children!.map((c, i) => <Node key={`${c.ref}-${i}`} node={c} depth={depth + 1} />)}
    </>
  );
});
Node.displayName = 'ElementsTab.Node';

export const ElementsTab = memo(({ handleId }: { handleId: AppHandleId }) => {
  const styles = useStyles();
  const [tree, setTree] = useState<AxNode | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const t = await emitter.invoke('app:snapshot', handleId);
      setTree(t);
    } catch {
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [handleId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span style={{ color: tokens.colorNeutralForeground3, fontSize: '11px' }}>
          Accessibility tree (snapshot)
        </span>
        <div className={styles.spacer} />
        <button type="button" className={styles.iconBtn} onClick={() => void refresh()} title="Re-snapshot">
          <ArrowClockwise16Regular />
        </button>
      </div>
      <div className={styles.tree}>
        {loading && !tree ? (
          <div className={styles.loading}>Loading…</div>
        ) : tree ? (
          <Node node={tree} depth={0} />
        ) : (
          <div className={styles.loading}>Could not capture the tree. Try again after the page loads.</div>
        )}
      </div>
    </div>
  );
});
ElementsTab.displayName = 'ElementsTab';
