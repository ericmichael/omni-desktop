import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiPencilSimpleBold, PiEyeBold } from 'react-icons/pi';
import { useStore } from '@nanostores/react';

import { IconButton } from '@/renderer/ds';
import { Markdown } from '@/renderer/omniagents-ui/components/promptkit/markdown';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { ticketApi } from './state';

const SAVE_DEBOUNCE_MS = 1000;

export const ProjectBrief = memo(({ projectId }: { projectId: ProjectId }) => {
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
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-surface-border shrink-0">
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Brief</span>
        <div className="flex-1" />
        <IconButton
          aria-label={mode === 'edit' ? 'Preview' : 'Edit'}
          icon={mode === 'edit' ? <PiEyeBold /> : <PiPencilSimpleBold />}
          size="sm"
          onClick={toggleMode}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleChange}
            spellCheck={false}
            className="w-full h-full resize-none bg-transparent text-sm text-fg font-mono p-4 focus:outline-none"
            placeholder="Describe the problem, appetite, solution direction, open questions..."
          />
        ) : (
          <div className="p-4">
            {draft.trim() ? (
              <Markdown inheritTextColor>{draft}</Markdown>
            ) : (
              <p className="text-sm text-fg-muted italic">No brief yet. Switch to edit mode to start writing.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
ProjectBrief.displayName = 'ProjectBrief';
