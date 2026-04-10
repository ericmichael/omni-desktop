import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Edit20Regular, Eye20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';

import { Textarea as FluentTextarea, makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { IconButton } from '@/renderer/ds';
import { Markdown } from '@/renderer/omniagents-ui/components/promptkit/markdown';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { ticketApi } from './state';

const SAVE_DEBOUNCE_MS = 1000;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  headerLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
  },
  flex1: {
    flex: '1 1 0',
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  previewPadding: {
    padding: tokens.spacingVerticalL,
  },
  emptyText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    fontStyle: 'italic',
  },
});

export const ProjectBrief = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const project = store.projects.find((p) => p.id === projectId);

  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [draft, setDraft] = useState(project?.brief ?? '');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft when project changes (e.g. switching projects)
  useEffect(() => {
    setDraft(project?.brief ?? '');
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(
    (content: string) => {
      void ticketApi.updateProject(projectId, { brief: content });
    },
    [projectId]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setDraft(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(value), SAVE_DEBOUNCE_MS);
    },
    [save]
  );

  // Save on unmount if there's a pending debounce
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        save(draft);
      }
    };
  }, [draft, save]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMode = useCallback(() => {
    if (mode === 'edit' && saveTimer.current) {
      clearTimeout(saveTimer.current);
      save(draft);
    }
    setMode((m) => (m === 'edit' ? 'preview' : 'edit'));
  }, [mode, draft, save]);

  // Focus textarea when switching to edit mode
  useEffect(() => {
    if (mode === 'edit') {
      textareaRef.current?.focus();
    }
  }, [mode]);

  if (!project) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Brief</span>
        <div className={styles.flex1} />
        <IconButton
          aria-label={mode === 'edit' ? 'Preview' : 'Edit'}
          icon={mode === 'edit' ? <Eye20Regular /> : <Edit20Regular />}
          size="sm"
          onClick={toggleMode}
        />
      </div>
      <div className={styles.body}>
        {mode === 'edit' ? (
          <FluentTextarea
            ref={textareaRef}
            value={draft}
            onChange={handleChange}
            spellCheck={false}
            resize="none"
            appearance="filled-lighter"
            placeholder="Describe the problem, appetite, solution direction, open questions..."
            style={{ width: '100%', height: '100%', fontFamily: tokens.fontFamilyMonospace }}
          />
        ) : (
          <div className={styles.previewPadding}>
            {draft.trim() ? (
              <Markdown inheritTextColor>{draft}</Markdown>
            ) : (
              <p className={styles.emptyText}>No brief yet. Switch to edit mode to start writing.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
ProjectBrief.displayName = 'ProjectBrief';
