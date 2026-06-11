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
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, tokens } from '@fluentui/react-components';
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  Delete16Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { $pendingMigrationNotice, migrationApi } from '@/renderer/features/MigrationNotice/state';

const formatCount = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

export const MigrationNotice = memo(() => {
  const state = useStore($pendingMigrationNotice);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const onToggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

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
    state.summary.perProjectPagesCopied +
    state.summary.rootPagesFromContextMd +
    state.summary.mcpPagesCopied;
  const moved = total > 0 ? `${formatCount(total, 'page')} moved.` : 'Layout updated.';
  const legacy = state.legacyPaths.length;

  return (
    <div
      style={{
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
        backgroundColor: tokens.colorNeutralBackground1,
        borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
      }}
    >
      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Pages moved to a shared location</MessageBarTitle>
          {moved} Your pages now live in a single tree so the launcher and
          external tools (Claude Desktop, Cursor, MCP) read and write the same
          files. The originals on your old paths weren&apos;t touched —{' '}
          {formatCount(legacy, 'legacy location')} can be removed when you&apos;re ready.
          {expanded && (
            <ul
              style={{
                marginTop: tokens.spacingVerticalS,
                paddingLeft: tokens.spacingHorizontalL,
                fontFamily: tokens.fontFamilyMonospace,
                fontSize: tokens.fontSizeBase200,
              }}
            >
              {state.legacyPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </MessageBarBody>
        <MessageBarActions>
          <Button
            size="small"
            appearance="subtle"
            icon={expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
            onClick={onToggleExpanded}
          >
            {expanded ? 'Hide details' : `Show details (${legacy})`}
          </Button>
          <Button
            size="small"
            appearance="primary"
            icon={<Delete16Regular />}
            disabled={busy || legacy === 0}
            onClick={onCleanup}
          >
            Clean up legacy files
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            disabled={busy}
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </MessageBarActions>
      </MessageBar>
    </div>
  );
});
MigrationNotice.displayName = 'MigrationNotice';
