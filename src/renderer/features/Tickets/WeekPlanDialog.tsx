import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Filled, MailInbox20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { isMilestonePinned, isProjectPinned } from '@/lib/home-rollup';
import { computeShippedDigest, type ShippedItem } from '@/lib/shipped-digest';
import {
  AnimatedDialog,
  Badge,
  Body1,
  Button,
  Caption1,
  Checkbox,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/renderer/ds';
import { $activeInbox } from '@/renderer/features/Inbox/state';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { $currentPrincipal } from '@/renderer/features/Teams/state';
import { $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Milestone, MilestoneId, Project, ProjectId } from '@/shared/types';

/** Composite key for a pinnable thing in the dialog's local pin set. */
type PinKey = `project:${ProjectId}` | `milestone:${MilestoneId}`;
const projectKey = (id: ProjectId): PinKey => `project:${id}`;
const milestoneKey = (id: MilestoneId): PinKey => `milestone:${id}`;

type PinTarget =
  | { kind: 'project'; project: Project; openCount: number; dueDays: number | null }
  | {
      kind: 'milestone';
      milestone: Milestone;
      projectLabel: string;
      resolved: number;
      total: number;
      dueDays: number | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

const useStyles = makeStyles({
  stepIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    marginBottom: tokens.spacingVerticalL,
  },
  stepBar: {
    height: '4px',
    flex: '1 1 0',
    borderRadius: '9999px',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
  },
  stepBarActive: { backgroundColor: tokens.colorBrandStroke1 },
  stepBarInactive: { backgroundColor: tokens.colorNeutralBackground3 },
  stepTitle: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    marginBottom: tokens.spacingVerticalS,
  },
  stepLead: {
    color: tokens.colorNeutralForeground2,
    marginBottom: tokens.spacingVerticalL,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    paddingTop: '32px',
    paddingBottom: '32px',
    textAlign: 'center',
  },
  emptyText: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300 },
  emptySub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  list: { display: 'flex', flexDirection: 'column', gap: '4px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
  },
  rowMain: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  rowTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  rowMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  checkIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  pinRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  pinRowChecked: {
    ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  pinWarning: {
    marginTop: tokens.spacingVerticalM,
    color: tokens.colorPaletteYellowForeground2,
  },
  inboxStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalL,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  inboxStripText: { flex: '1 1 0', color: tokens.colorNeutralForeground2 },
  footerBetween: { justifyContent: 'space-between' },
});

type Step = 'recap' | 'plan';
const STEPS: Step[] = ['recap', 'plan'];

const STEP_TITLES: Record<Step, string> = {
  recap: 'Recently shipped',
  plan: 'This week',
};

/* ---------- Step: Recently shipped ---------- */

const RecapStep = memo(
  ({ items, ticketCount, milestoneCount, inboxCount, onOpenInbox }: {
    items: ShippedItem[];
    ticketCount: number;
    milestoneCount: number;
    inboxCount: number;
    onOpenInbox: () => void;
  }) => {
    const styles = useStyles();
    const store = useStore(persistedStoreApi.$atom);
    const projectMap = useMemo(() => {
      const m: Record<string, string> = {};
      for (const p of store.projects) {
        m[p.id] = p.label;
      }
      return m;
    }, [store.projects]);

    return (
      <>
        <Body1 className={styles.stepLead}>
          {ticketCount + milestoneCount === 0
            ? 'Nothing shipped recently.'
            : `${ticketCount} ticket${ticketCount === 1 ? '' : 's'}${
                milestoneCount > 0
                  ? ` · ${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'}`
                  : ''
              } shipped recently.`}
        </Body1>

        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>No shipped items to recap.</p>
            <p className={styles.emptySub}>That&apos;s OK — quality over quantity.</p>
          </div>
        ) : (
          <div className={styles.list}>
            {items.map((item) => {
              const title = item.kind === 'ticket' ? item.ticket.title : item.milestone.title;
              const projectId =
                item.kind === 'ticket' ? item.ticket.projectId : item.milestone.projectId;
              const sub = item.kind === 'ticket' ? 'Ticket shipped' : 'Milestone completed';
              const key = item.kind === 'ticket' ? `t:${item.ticket.id}` : `m:${item.milestone.id}`;
              return (
                <div key={key} className={styles.row}>
                  <CheckmarkCircle20Filled
                    style={{ width: 16, height: 16 }}
                    className={styles.checkIcon}
                  />
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{title}</span>
                    <span className={styles.rowSub}>
                      {projectMap[projectId] ?? ''} · {sub}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {inboxCount > 0 && (
          <div className={styles.inboxStrip}>
            <MailInbox20Regular />
            <Caption1 className={styles.inboxStripText}>
              {inboxCount} item{inboxCount === 1 ? '' : 's'} waiting in your inbox.
            </Caption1>
            <Button size="sm" variant="ghost" onClick={onOpenInbox}>
              Open inbox
            </Button>
          </div>
        )}
      </>
    );
  }
);
RecapStep.displayName = 'RecapStep';

/* ---------- Step: This week ---------- */

const PinRow = memo(
  ({
    target,
    checked,
    onToggle,
  }: {
    target: PinTarget;
    checked: boolean;
    onToggle: (key: PinKey) => void;
  }) => {
    const styles = useStyles();
    const key: PinKey =
      target.kind === 'project' ? projectKey(target.project.id) : milestoneKey(target.milestone.id);
    const handleChange = useCallback(() => onToggle(key), [key, onToggle]);

    if (target.kind === 'project') {
      const { project, openCount, dueDays } = target;
      return (
        <label className={mergeClasses(styles.pinRow, checked && styles.pinRowChecked)}>
          <Checkbox checked={checked} onCheckedChange={handleChange} />
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{project.label}</span>
            <div className={styles.rowMeta}>
              <span className={styles.rowSub}>Project</span>
              <Caption1>
                {openCount} open ticket{openCount === 1 ? '' : 's'}
              </Caption1>
              {dueDays !== null && (
                <Caption1>
                  {dueDays <= 0 ? `${Math.abs(dueDays)}d overdue` : `due in ${dueDays}d`}
                </Caption1>
              )}
            </div>
          </div>
        </label>
      );
    }

    const { milestone, projectLabel, resolved, total, dueDays } = target;
    return (
      <label className={mergeClasses(styles.pinRow, checked && styles.pinRowChecked)}>
        <Checkbox checked={checked} onCheckedChange={handleChange} />
        <div className={styles.rowMain}>
          <span className={styles.rowTitle}>{milestone.title}</span>
          <div className={styles.rowMeta}>
            <span className={styles.rowSub}>{projectLabel} · Milestone</span>
            <Badge>
              {resolved}/{total}
            </Badge>
            {dueDays !== null && (
              <Caption1>
                {dueDays <= 0 ? `${Math.abs(dueDays)}d overdue` : `due in ${dueDays}d`}
              </Caption1>
            )}
          </div>
        </div>
      </label>
    );
  }
);
PinRow.displayName = 'PinRow';

const PlanStep = memo(
  ({
    targets,
    pinSet,
    onToggle,
  }: {
    targets: PinTarget[];
    pinSet: Set<PinKey>;
    onToggle: (key: PinKey) => void;
  }) => {
    const styles = useStyles();

    if (targets.length === 0) {
      return (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>No projects or milestones to pin.</p>
          <p className={styles.emptySub}>Create a project to plan your week.</p>
        </div>
      );
    }

    return (
      <>
        <Body1 className={styles.stepLead}>What are you committing to this week?</Body1>
        <div className={styles.list}>
          {targets.map((target) => {
            const key: PinKey =
              target.kind === 'project'
                ? projectKey(target.project.id)
                : milestoneKey(target.milestone.id);
            return (
              <PinRow
                key={key}
                target={target}
                checked={pinSet.has(key)}
                onToggle={onToggle}
              />
            );
          })}
        </div>
        {pinSet.size > 3 && (
          <Caption1 className={styles.pinWarning}>
            You&apos;ve pinned {pinSet.size}. Most weeks 1–3 is realistic.
          </Caption1>
        )}
      </>
    );
  }
);
PlanStep.displayName = 'PlanStep';

/* ---------- Main dialog ---------- */

type WeekPlanDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const WeekPlanDialog = memo(({ open, onClose }: WeekPlanDialogProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const milestones = useStore($milestones);
  const activeInbox = useStore($activeInbox);

  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  // Recap = rolling 14-day window of recent shipped work. Label is "Recently
  // shipped" rather than "Last week" so the framing is honest no matter when
  // the dialog is opened — recap is context for the plan, not a strict report.
  const now = Date.now();
  const digest = useMemo(() => {
    const startOfWindow = now - 14 * DAY_MS;
    return computeShippedDigest({
      tickets: store.tickets,
      milestones: Object.values(milestones),
      startOfToday: startOfWindow,
      startOfWeek: startOfWindow,
    });
  }, [store.tickets, milestones, now]);

  const tickets = useStore($tickets);
  const reviewPrincipal = useStore($currentPrincipal);

  // Pin targets: every project + every active milestone. Sorted with projects
  // first, then milestones, each group oldest-first for predictability.
  const targets = useMemo<PinTarget[]>(() => {
    const projectLabels = new Map<string, string>();
    for (const project of store.projects) {
      projectLabels.set(project.id, project.label);
    }

    const now = Date.now();
    const projectTargets: PinTarget[] = store.projects
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((project) => {
        let openCount = 0;
        for (const ticket of Object.values(tickets)) {
          if (ticket.projectId !== project.id) {
continue;
}
          if (ticket.resolution !== undefined) {
continue;
}
          // Teams: a weekly review is personal — count only my assigned work.
          // Single-user (no principal): count all open tickets (legacy).
          if (reviewPrincipal && ticket.assignee !== reviewPrincipal) {
continue;
}
          openCount++;
        }
        const dueDays =
          project.dueDate !== undefined ? Math.ceil((project.dueDate - now) / DAY_MS) : null;
        return { kind: 'project', project, openCount, dueDays } as PinTarget;
      });

    const milestoneTargets: PinTarget[] = Object.values(milestones)
      .filter((m) => m.status === 'active')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((milestone) => {
        const milestoneTickets = Object.values(tickets).filter(
          (t) => t.milestoneId === milestone.id
        );
        const resolved = milestoneTickets.filter((t) => t.resolution !== undefined).length;
        const total = milestoneTickets.length;
        const dueDays =
          milestone.dueDate !== undefined
            ? Math.ceil((milestone.dueDate - now) / DAY_MS)
            : null;
        return {
          kind: 'milestone',
          milestone,
          projectLabel: projectLabels.get(milestone.projectId) ?? '',
          resolved,
          total,
          dueDays,
        } as PinTarget;
      });

    return [...projectTargets, ...milestoneTargets];
  }, [store.projects, milestones, tickets, reviewPrincipal]);

  // Pin set, seeded from currently-pinned projects and milestones.
  const [pinSet, setPinSet] = useState<Set<PinKey>>(() => {
    const s = new Set<PinKey>();
    for (const project of store.projects) {
      if (isProjectPinned(project)) {
        s.add(projectKey(project.id));
      }
    }
    for (const m of Object.values(milestones)) {
      if (isMilestonePinned(m)) {
        s.add(milestoneKey(m.id));
      }
    }
    return s;
  });

  const handleToggle = useCallback((key: PinKey) => {
    setPinSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex]);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
    }
  }, [stepIndex]);

  const handleOpenInbox = useCallback(() => {
    ticketApi.goToInbox();
    onClose();
  }, [onClose]);

  const handleFinish = useCallback(() => {
    const stamp = Date.now();
    // Write both directions for every project and active milestone — pins are
    // fully derived from the checkbox state, so unchecked rows clear stale pins.
    for (const project of store.projects) {
      const shouldBePinned = pinSet.has(projectKey(project.id));
      const currentlyPinned = project.pinnedAt !== undefined;
      if (shouldBePinned) {
        void ticketApi.updateProject(project.id, { pinnedAt: stamp });
      } else if (currentlyPinned) {
        void ticketApi.updateProject(project.id, { pinnedAt: undefined });
      }
    }
    for (const milestone of Object.values(milestones)) {
      if (milestone.status !== 'active') {
continue;
}
      const shouldBePinned = pinSet.has(milestoneKey(milestone.id));
      const currentlyPinned = milestone.pinnedAt !== undefined;
      if (shouldBePinned) {
        void milestoneApi.updateMilestone(milestone.id, { pinnedAt: stamp });
      } else if (currentlyPinned) {
        void milestoneApi.updateMilestone(milestone.id, { pinnedAt: undefined });
      }
    }
    persistedStoreApi.setKey('lastWeeklyReviewAt', stamp);
    setStepIndex(0);
    onClose();
  }, [store.projects, milestones, pinSet, onClose]);

  const isLast = step === 'plan';

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Plan your week</DialogHeader>
        <DialogBody>
          <div className={styles.stepIndicator}>
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={mergeClasses(
                  styles.stepBar,
                  i <= stepIndex ? styles.stepBarActive : styles.stepBarInactive
                )}
              />
            ))}
          </div>
          <p className={styles.stepTitle}>{STEP_TITLES[step]}</p>

          {step === 'recap' && (
            <RecapStep
              items={digest.week.items}
              ticketCount={digest.week.ticketCount}
              milestoneCount={digest.week.milestoneCount}
              inboxCount={activeInbox.length}
              onOpenInbox={handleOpenInbox}
            />
          )}
          {step === 'plan' && (
            <PlanStep targets={targets} pinSet={pinSet} onToggle={handleToggle} />
          )}
        </DialogBody>
        <DialogFooter className={styles.footerBetween}>
          <div>
            {stepIndex > 0 && (
              <Button size="sm" variant="ghost" onClick={handleBack}>
                Back
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isLast && (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Skip
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={handleFinish}>
                Finish
              </Button>
            ) : (
              <Button size="sm" onClick={handleNext}>
                Next
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
WeekPlanDialog.displayName = 'WeekPlanDialog';
