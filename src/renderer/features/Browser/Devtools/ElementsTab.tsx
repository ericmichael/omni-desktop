/**
 * Elements tab — renders the accessibility tree from `app:snapshot` as a
 * collapsible outline. Each row shows role + name + optional value. Useful
 * for understanding what `app_snapshot` refs correspond to while iterating
 * on an automation script.
 */
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId, AxNode } from '@/shared/app-control-types';

const Node = memo(({ node, depth }: { node: AxNode; depth: number }) => {
  const hasChildren = !!node.children && node.children.length > 0;
  const [open, setOpen] = useState(depth < 2);

  return (
    <>
      <div
        className="flex cursor-pointer items-center gap-1 whitespace-nowrap py-px pr-1 pl-1.5 hover:bg-accent"
        onClick={hasChildren ? () => setOpen((v) => !v) : undefined}
      >
        <span className="inline-flex size-3.5 items-center justify-center shrink-0 text-muted-foreground">
          {hasChildren ? open ? <ChevronDown /> : <ChevronRight /> : null}
        </span>
        <span className="flex-none text-muted-foreground text-xs">{node.ref}</span>
        <span className="text-primary font-semibold">{node.role}</span>
        {node.name && <span className="text-foreground ml-2">“{node.name}”</span>}
        {node.value && <span className="text-muted-foreground ml-2 italic">= {node.value}</span>}
      </div>
      {hasChildren && open && (
        <div className="pl-3.5">
          {node.children!.map((c, i) => (
            <Node key={`${c.ref}-${i}`} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </>
  );
});
Node.displayName = 'ElementsTab.Node';

export const ElementsTab = memo(({ handleId }: { handleId: AppHandleId }) => {
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
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 h-7 pl-4 pr-4 border-b border-border bg-card text-xs">
        <span className="text-xs text-muted-foreground">Accessibility tree (snapshot)</span>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => void refresh()} aria-label="Re-snapshot">
          <RefreshCw />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1 font-mono text-xs">
        {loading && !tree ? (
          <div className="p-4 text-center text-muted-foreground">Loading…</div>
        ) : tree ? (
          <Node node={tree} depth={0} />
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            Could not capture the tree. Try again after the page loads.
          </div>
        )}
      </div>
    </div>
  );
});
ElementsTab.displayName = 'ElementsTab';
