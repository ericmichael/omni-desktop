import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { Edit20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { Badge, Button, IconButton, SectionLabel, Select, Textarea } from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import type { Ticket, TicketPriority, TicketResolution } from '@/shared/types';

import { APPETITE_COLORS, APPETITE_DESCRIPTIONS, APPETITE_LABELS, getColumnColors, RESOLUTION_COLORS, RESOLUTION_LABELS } from './ticket-constants';
import { $pipeline, $tickets, ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
    maxWidth: '42rem',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  editActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  descriptionText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  tapToAdd: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'color',
    transitionDuration: '150ms',
    backgroundColor: 'transparent',
    border: 'none',
    ':hover': {
      color: tokens.colorNeutralForeground2,
    },
  },
  scopeCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: 'rgba(var(--colorNeutralBackground2), 0.3)',
    padding: tokens.spacingVerticalM,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  scopeFieldLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground2,
  },
  scopeFieldValue: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    marginTop: '2px',
  },
  blockerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  blockerTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  blockerList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  noBlockers: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  infoText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  tokenRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  detailSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  detailRow: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalL,
    rowGap: '4px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
});

type TicketOverviewTabProps = {
  ticket: Ticket;
};

export const TicketOverviewTab = memo(({ ticket }: TicketOverviewTabProps) => {
  const styles = useStyles();
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const milestones = useStore($milestones);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  const currentColumn = useMemo(() => {
    if (!ticket.columnId || !pipeline) return undefined;
    return pipeline.columns.find((c) => c.id === ticket.columnId);
  }, [ticket, pipeline]);

  const milestone = ticket.milestoneId ? milestones[ticket.milestoneId] : undefined;

  const blockerTickets = useMemo(() => {
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

  const availableBlockers = useMemo(() => {
    const blocked = new Set(ticket.blockedBy);
    return Object.values(tickets).filter((t) => t.id !== ticket.id && t.projectId === ticket.projectId && !blocked.has(t.id));
  }, [ticket, tickets]);

  const handleColumnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) {
        void ticketApi.moveTicketToColumn(ticket.id, e.target.value);
      }
    },
    [ticket.id]
  );

  const handleResolve = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      if (val === '__clear__') {
        void ticketApi.updateTicket(ticket.id, { resolution: undefined });
      } else if (val) {
        void ticketApi.resolveTicket(ticket.id, val as TicketResolution);
      }
    },
    [ticket.id]
  );

  const handlePriorityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void ticketApi.updateTicket(ticket.id, { priority: e.target.value as TicketPriority });
    },
    [ticket.id]
  );

  const handleAddBlocker = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const blockerId = e.target.value;
      if (!blockerId) return;
      void ticketApi.updateTicket(ticket.id, { blockedBy: [...ticket.blockedBy, blockerId] });
    },
    [ticket.id, ticket.blockedBy]
  );

  const handleRemoveBlocker = useCallback(
    (blockerId: string) => {
      void ticketApi.updateTicket(ticket.id, { blockedBy: ticket.blockedBy.filter((id) => id !== blockerId) });
    },
    [ticket.id, ticket.blockedBy]
  );

  const handleStartEditDescription = useCallback(() => {
    setEditDescription(ticket.description);
    setEditingDescription(true);
  }, [ticket]);

  const handleEditDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (editDescription !== ticket.description) {
      void ticketApi.updateTicket(ticket.id, { description: editDescription });
    }
    setEditingDescription(false);
  }, [editDescription, ticket]);

  const handleDescriptionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingDescription(false);
    }
  }, []);

  const handleCancelEditDescription = useCallback(() => {
    setEditingDescription(false);
  }, []);

  return (
    <div className={styles.root}>
      {/* Status metadata */}
      <div className={styles.section}>
        <SectionLabel>Status</SectionLabel>
        <div className={styles.metaRow}>
          {pipeline && (
            <Select size="sm" value={ticket.columnId ?? ''} onChange={handleColumnChange} className="w-40">
              {pipeline.columns.map((col) => (
                <option key={col.id} value={col.id}>{col.label}</option>
              ))}
            </Select>
          )}
          {ticket.resolution && (
            <Badge color={RESOLUTION_COLORS[ticket.resolution]}>{RESOLUTION_LABELS[ticket.resolution]}</Badge>
          )}
          {milestone && (
            <Badge color="purple" truncate>{milestone.title}</Badge>
          )}
        </div>
      </div>

      {/* Description */}
      <div className={styles.section}>
        <div className={styles.labelRow}>
          <SectionLabel>Description</SectionLabel>
          {!editingDescription && (
            <IconButton
              aria-label="Edit description"
              icon={<Edit20Regular />}
              size="sm"
              onClick={handleStartEditDescription}
            />
          )}
        </div>
        {editingDescription ? (
          <div className={styles.section}>
            <Textarea
              value={editDescription}
              onChange={handleEditDescriptionChange}
              onKeyDown={handleDescriptionKeyDown}
              autoFocus
              rows={5}
              maxHeight={400}
              placeholder="Ticket description..."
            />
            <div className={styles.editActions}>
              <Button size="sm" onClick={handleSaveDescription}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEditDescription}>
                Cancel
              </Button>
            </div>
          </div>
        ) : ticket.description ? (
          <p className={styles.descriptionText}>{ticket.description}</p>
        ) : (
          <button onClick={handleStartEditDescription} className={styles.tapToAdd}>
            Tap to add description
          </button>
        )}
      </div>

      {/* Scope (from shaping) */}
      {ticket.shaping && (
        <div className={styles.section}>
          <SectionLabel>Scope</SectionLabel>
          <div className={styles.scopeCard}>
            <div>
              <span className={styles.scopeFieldLabel}>Done looks like</span>
              <p className={styles.scopeFieldValue}>{ticket.shaping.doneLooksLike}</p>
            </div>
            <div>
              <span className={styles.scopeFieldLabel}>Appetite</span>
              <div style={{ marginTop: '2px' }}>
                <Badge color={APPETITE_COLORS[ticket.shaping.appetite]}>
                  {APPETITE_LABELS[ticket.shaping.appetite]} — {APPETITE_DESCRIPTIONS[ticket.shaping.appetite]}
                </Badge>
              </div>
            </div>
            <div>
              <span className={styles.scopeFieldLabel}>Out of scope</span>
              <p className={styles.scopeFieldValue}>{ticket.shaping.outOfScope}</p>
            </div>
          </div>
        </div>
      )}

      {/* Priority */}
      <div className={styles.section}>
        <SectionLabel>Priority</SectionLabel>
        <Select size="sm" value={ticket.priority} onChange={handlePriorityChange} className="w-full sm:w-40">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </Select>
      </div>

      {/* Dependencies */}
      <div className={styles.section}>
        <SectionLabel>Blocked By</SectionLabel>
        {blockerTickets.length > 0 && (
          <div className={styles.blockerList}>
            {blockerTickets.map((blocker) => (
              <div key={blocker.id} className={styles.blockerRow}>
                <Badge
                  color="default"
                  style={{
                    color: getColumnColors(blocker.columnId ?? 'backlog').badgeColor,
                    backgroundColor: getColumnColors(blocker.columnId ?? 'backlog').badgeBg,
                  }}
                >
                  {blocker.columnId ?? 'backlog'}
                </Badge>
                <span className={styles.blockerTitle}>{blocker.title}</span>
                <IconButton
                  aria-label={`Remove blocker ${blocker.title}`}
                  icon={<Dismiss20Regular />}
                  size="sm"
                  onClick={() => handleRemoveBlocker(blocker.id)}
                />
              </div>
            ))}
          </div>
        )}
        {availableBlockers.length > 0 && (
          <Select size="sm" value="" onChange={handleAddBlocker} className="w-full sm:w-60">
            <option value="">Add dependency...</option>
            {availableBlockers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        )}
        {blockerTickets.length === 0 && availableBlockers.length === 0 && (
          <p className={styles.noBlockers}>No tickets available to block on</p>
        )}
      </div>

      {/* Supervisor info */}
      {ticket.supervisorSessionId && (
        <div className={styles.section}>
          <SectionLabel>Supervisor</SectionLabel>
          <div className={styles.infoText}>
            <p>Session: {ticket.supervisorSessionId}</p>
            {ticket.phase && <p>Phase: {ticket.phase}</p>}
          </div>
        </div>
      )}

      {/* Token usage */}
      {ticket.tokenUsage && (
        <div className={styles.section}>
          <SectionLabel>Token Usage</SectionLabel>
          <div className={styles.tokenRow}>
            <span>In: {ticket.tokenUsage.inputTokens.toLocaleString()}</span>
            <span>Out: {ticket.tokenUsage.outputTokens.toLocaleString()}</span>
            <span>Total: {ticket.tokenUsage.totalTokens.toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className={styles.detailSection}>
        <SectionLabel>Details</SectionLabel>
        <div className={styles.detailRow}>
          <span>Created {new Date(ticket.createdAt).toLocaleDateString()}</span>
          <span>Updated {new Date(ticket.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
});
TicketOverviewTab.displayName = 'TicketOverviewTab';
