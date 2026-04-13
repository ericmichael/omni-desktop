import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Add20Regular, Star20Filled } from '@fluentui/react-icons';
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';

import { Caption1, Input, Subtitle2 } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { ticketApi } from './state';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingHorizontalL,
    overflowY: 'auto',
    height: '100%',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: '8px',
    cursor: 'pointer',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    minHeight: '120px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
      boxShadow: tokens.shadow4,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground2Pressed,
    },
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  personalStar: {
    color: tokens.colorPaletteYellowForeground1,
    flexShrink: 0,
    width: '16px',
    height: '16px',
  },
  preview: {
    color: tokens.colorNeutralForeground3,
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    lineHeight: '1.4',
  },
  counts: {
    color: tokens.colorNeutralForeground3,
    marginTop: 'auto',
  },
  addCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
    backgroundColor: 'transparent',
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke1),
    borderRadius: '8px',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    minHeight: '120px',
    color: tokens.colorNeutralForeground3,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
  addIcon: {
    width: '28px',
    height: '28px',
  },
  addInput: {
    width: '100%',
  },
});

export const ProjectCardsGrid = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const projects = store.projects;
  const [previews, setPreviews] = useState<Record<ProjectId, string>>({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Load context previews
  useEffect(() => {
    for (const project of projects) {
      void ticketApi.getContextPreview(project.id).then((preview) => {
        setPreviews((prev) => ({ ...prev, [project.id]: preview }));
      });
    }
  }, [projects]);

  const ticketCounts = useMemo(() => {
    const counts: Record<string, { active: number; total: number }> = {};
    for (const ticket of store.tickets) {
      const entry = counts[ticket.projectId] ?? { active: 0, total: 0 };
      entry.total++;
      if (!ticket.resolution) {
        entry.active++;
      }
      counts[ticket.projectId] = entry;
    }
    return counts;
  }, [store.tickets]);

  const handleAddClick = useCallback(() => {
    setCreating(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      setNewName('');
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const project = await ticketApi.addProject({ label: name, slug });
    setCreating(false);
    setNewName('');
    ticketApi.goToProject(project.id);
  }, [newName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleCreate();
      } else if (e.key === 'Escape') {
        setCreating(false);
        setNewName('');
      }
    },
    [handleCreate]
  );

  return (
    <div className={styles.grid}>
      {projects.map((project) => {
        const preview = previews[project.id] ?? '';
        const counts = ticketCounts[project.id];
        const countLabel = counts
          ? `${counts.active} active / ${counts.total} total`
          : '0 items';

        return (
          <button
            type="button"
            key={project.id}
            className={styles.card}
            onClick={() => ticketApi.goToProject(project.id)}
          >
            <div className={styles.cardHeader}>
              {project.isPersonal && <Star20Filled className={styles.personalStar} />}
              <Subtitle2>{project.label}</Subtitle2>
            </div>
            {preview.trim() && (
              <Caption1 className={styles.preview}>{preview.trim()}</Caption1>
            )}
            <Caption1 className={styles.counts}>{countLabel}</Caption1>
          </button>
        );
      })}

      {creating ? (
        <div className={styles.card} style={{ cursor: 'default' }}>
          <Subtitle2>New project</Subtitle2>
          <Input
            ref={inputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => void handleCreate()}
            placeholder="Project name..."
            className={styles.addInput}
          />
        </div>
      ) : (
        <button type="button" className={styles.addCard} onClick={handleAddClick}>
          <Add20Regular className={styles.addIcon} />
          <Caption1>New project</Caption1>
        </button>
      )}
    </div>
  );
});
ProjectCardsGrid.displayName = 'ProjectCardsGrid';
