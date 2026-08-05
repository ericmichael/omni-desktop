/**
 * One-shot post-migration banner for the Task #18 pages relocation.
 *
 * Renders only when the main process has recorded a pending notice in
 * `StoreData.pagesMigration` and the user hasn't dismissed it yet.
 *
 * Three affordances:
 *   - Show details: expands a small panel listing the legacy paths so
 *     power users know exactly what's still on disk before deciding.
 *   - Clean up: deletes the recorded legacy paths and clears the notice.
 *     Idempotent + scoped strictly to paths the migration recorded.
 *   - Dismiss: clears the notice without touching anything on disk.
 */
import { useStore } from '@nanostores/react';
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { $pendingMigrationNotice, migrationApi } from '@/renderer/features/MigrationNotice/state';

const formatCount = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

export const MigrationNotice = memo(() => {
  const state = useStore($pendingMigrationNotice);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const onDismiss = useCallback(() => {
    setBusy(true);
    void migrationApi.acknowledge().finally(() => setBusy(false));
  }, []);

  const onCleanup = useCallback(() => {
    setBusy(true);
    void migrationApi.cleanupLegacy().finally(() => setBusy(false));
  }, []);

  if (!state) {
    return null;
  }

  const total =
    state.summary.perProjectPagesCopied + state.summary.rootPagesFromContextMd + state.summary.mcpPagesCopied;
  const moved = total > 0 ? `${formatCount(total, 'page')} moved.` : 'Layout updated.';
  const legacy = state.legacyPaths.length;

  return (
    <div className="border-b bg-background px-5 py-2">
      <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
        <Alert>
          <AlertDescription>
            <div className="font-medium">Pages moved to a shared location</div>
            {moved} Your pages now live in a single tree so the launcher and external tools (Claude Desktop, Cursor,
            MCP) read and write the same files. The originals on your old paths weren&apos;t touched —{' '}
            {formatCount(legacy, 'legacy location')} can be removed when you&apos;re ready.
            <CollapsibleContent asChild>
              <ul className="mt-2 pl-5 font-mono text-xs">
                {state.legacyPaths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </AlertDescription>
          <div className="col-start-2 flex gap-2">
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost">
                {expanded ? <ChevronUp /> : <ChevronDown />}
                {expanded ? 'Hide details' : `Show details (${legacy})`}
              </Button>
            </CollapsibleTrigger>
            <Button size="sm" variant="default" disabled={busy || legacy === 0} onClick={onCleanup}>
              <Trash2 />
              Clean up legacy files
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
              <X />
              Dismiss
            </Button>
          </div>
        </Alert>
      </Collapsible>
    </div>
  );
});
MigrationNotice.displayName = 'MigrationNotice';
