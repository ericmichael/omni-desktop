import { useStore } from '@nanostores/react';
import { Ellipsis, Play, Plus, Trash2, Zap } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { describeTrigger } from '@/lib/automations';
import { cn } from '@/renderer/ds/cn';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Switch } from '@/renderer/ds/ui/switch';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { toast } from '@/renderer/features/Toast/state';
import { automationApi } from '@/renderer/services/automations';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Automation, AutomationInput, AutomationTrigger, PullRequestEventKind, StoreData } from '@/shared/types';

// ---------------------------------------------------------------------------
// Form state <-> Automation
// ---------------------------------------------------------------------------

const PR_EVENT_KINDS: Array<{ value: PullRequestEventKind; label: string }> = [
  { value: 'ci_failed', label: 'CI failed' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed without merging' },
  { value: 'ci_green', label: 'CI recovered' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type FormState = {
  name: string;
  agentId: string;
  instruction: string;
  triggerKind: AutomationTrigger['kind'];
  /** '' = any PR event. */
  prEvent: '' | PullRequestEventKind;
  prRepo: string;
  channel: string;
  contains: string;
  scheduleKind: 'interval' | 'daily' | 'weekly';
  everyMinutes: string;
  time: string;
  dayOfWeek: string;
};

const emptyForm = (agentId: string): FormState => ({
  name: '',
  agentId,
  instruction: '',
  triggerKind: 'pr_event',
  prEvent: '',
  prRepo: '',
  channel: 'team',
  contains: '',
  scheduleKind: 'daily',
  everyMinutes: '60',
  time: '09:00',
  dayOfWeek: '1',
});

const toForm = (a: Automation): FormState => {
  const base = emptyForm(a.agentId);
  const t = a.trigger;
  return {
    ...base,
    name: a.name,
    instruction: a.instruction,
    triggerKind: t.kind,
    ...(t.kind === 'pr_event' ? { prEvent: t.events?.[0] ?? '', prRepo: t.repo ?? '' } : {}),
    ...(t.kind === 'channel_message' ? { channel: t.channel, contains: t.contains ?? '' } : {}),
    ...(t.kind === 'schedule' && t.schedule.kind === 'interval'
      ? { scheduleKind: 'interval' as const, everyMinutes: String(t.schedule.everyMinutes) }
      : {}),
    ...(t.kind === 'schedule' && t.schedule.kind === 'daily'
      ? { scheduleKind: 'daily' as const, time: t.schedule.time }
      : {}),
    ...(t.kind === 'schedule' && t.schedule.kind === 'weekly'
      ? { scheduleKind: 'weekly' as const, time: t.schedule.time, dayOfWeek: String(t.schedule.dayOfWeek) }
      : {}),
  };
};

const toTrigger = (form: FormState): AutomationTrigger => {
  if (form.triggerKind === 'pr_event') {
    return {
      kind: 'pr_event',
      ...(form.prEvent ? { events: [form.prEvent] } : {}),
      ...(form.prRepo.trim() ? { repo: form.prRepo.trim() } : {}),
    };
  }
  if (form.triggerKind === 'channel_message') {
    return {
      kind: 'channel_message',
      channel: form.channel.trim().replace(/^#/, '') || 'team',
      ...(form.contains.trim() ? { contains: form.contains.trim() } : {}),
    };
  }
  if (form.scheduleKind === 'interval') {
    return {
      kind: 'schedule',
      schedule: { kind: 'interval', everyMinutes: Math.max(1, Number(form.everyMinutes) || 60) },
    };
  }
  if (form.scheduleKind === 'weekly') {
    return { kind: 'schedule', schedule: { kind: 'weekly', dayOfWeek: Number(form.dayOfWeek) || 1, time: form.time } };
  }
  return { kind: 'schedule', schedule: { kind: 'daily', time: form.time } };
};

const toInput = (form: FormState): AutomationInput => ({
  name: form.name,
  agentId: form.agentId,
  instruction: form.instruction,
  trigger: toTrigger(form),
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const stopPropagation = (e: React.SyntheticEvent): void => e.stopPropagation();

type RowProps = {
  automation: Automation;
  agentName: string;
  onEdit: (a: Automation) => void;
  onRunNow: (a: Automation) => void;
  onRequestDelete: (a: Automation) => void;
};

const AutomationRow = memo(({ automation, agentName, onEdit, onRunNow, onRequestDelete }: RowProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const handleClick = useCallback(() => onEdit(automation), [onEdit, automation]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onEdit(automation);
      }
    },
    [onEdit, automation]
  );
  const handleToggle = useCallback(
    (enabled: boolean) => void automationApi.update(automation.id, { enabled }),
    [automation.id]
  );

  return (
    // div+role rather than <button>: the row hosts the switch and "…" menu,
    // and nesting buttons inside a button is invalid markup (RoutineRow idiom).
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col items-stretch gap-0.5 pl-5 pr-2 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2 [&:hover_.automation-row-menu]:opacity-100 [&:focus-within_.automation-row-menu]:opacity-100"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm',
            automation.enabled ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {automation.name}
        </span>
        <span role="presentation" className="flex items-center shrink-0" onClick={stopPropagation}>
          <Switch
            checked={automation.enabled}
            onCheckedChange={handleToggle}
            aria-label={automation.enabled ? 'Disable automation' : 'Enable automation'}
          />
        </span>
        <span
          role="presentation"
          className={cn(
            'flex items-center shrink-0 opacity-0 transition-opacity duration-100',
            'automation-row-menu',
            menuOpen && 'opacity-100'
          )}
          onClick={stopPropagation}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Automation actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => onRunNow(automation)}>
                <Play />
                Run now
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => onRequestDelete(automation)}>
                <Trash2 />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </span>
      <span className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
        {describeTrigger(automation.trigger)} → wake {agentName}
        {automation.lastFiredAt
          ? ` · fired ${automation.fireCount === 1 ? 'once' : `${automation.fireCount}×`}`
          : ' · never fired'}
      </span>
    </div>
  );
});
AutomationRow.displayName = 'AutomationRow';

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * The Automations band on the Routines surface: user-defined event rules —
 * when <trigger> fires, wake <resident> with a standing instruction. The run
 * trace is the agent's own session/channel log, so rows carry no history UI;
 * "Run now" fires the rule for real as its test button.
 */
const NO_AGENTS: StoreData['residentAgents'] = [];

export const AutomationsSection = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const automations = store.automations ?? [];
  const agents = store.residentAgents ?? NO_AGENTS;

  const [dialog, setDialog] = useState<{ mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: string }>({
    mode: 'closed',
  });
  const [form, setForm] = useState<FormState>(() => emptyForm(''));
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);

  const agentName = useCallback((agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId, [agents]);

  const openCreate = useCallback(() => {
    setError(null);
    setForm(emptyForm(agents[0]?.id ?? ''));
    setDialog({ mode: 'create' });
  }, [agents]);

  const openEdit = useCallback((a: Automation) => {
    setError(null);
    setForm(toForm(a));
    setDialog({ mode: 'edit', id: a.id });
  }, []);

  const close = useCallback(() => setDialog({ mode: 'closed' }), []);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      if (dialog.mode === 'edit') {
        await automationApi.update(dialog.id, toInput(form));
      } else {
        await automationApi.create(toInput(form));
      }
      setDialog({ mode: 'closed' });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runNow = useCallback(
    (a: Automation) => {
      void automationApi
        .runNow(a.id)
        .then(() => toast.info('Automation fired', `${agentName(a.agentId)} was woken with the instruction.`))
        .catch((err: Error) => toast.error('Automation failed', err.message));
    },
    [agentName]
  );

  const confirmDelete = useCallback(() => {
    if (pendingDelete) {
      void automationApi.delete(pendingDelete.id);
    }
    setPendingDelete(null);
  }, [pendingDelete]);

  const field = (patch: Partial<FormState>): void => setForm((f) => ({ ...f, ...patch }));
  const submittable = form.name.trim() && form.agentId && form.instruction.trim();

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-2 min-w-0 pl-5 pr-5 pt-4 pb-2">
        <Zap className="size-4 text-muted-foreground shrink-0" />
        <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-foreground">
          Automations
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={openCreate}>
          <Plus />
          New automation
        </Button>
      </div>
      {automations.length === 0 ? (
        <Empty className="pt-2 pb-6">
          <EmptyHeader>
            <EmptyTitle className="text-sm">No automations yet</EmptyTitle>
            <EmptyDescription>
              When something happens — a PR event, a channel message, a schedule — wake an agent with a standing
              instruction.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        automations.map((a) => (
          <AutomationRow
            key={a.id}
            automation={a}
            agentName={agentName(a.agentId)}
            onEdit={openEdit}
            onRunNow={runNow}
            onRequestDelete={setPendingDelete}
          />
        ))
      )}

      <Dialog open={dialog.mode !== 'closed'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialog.mode === 'edit' ? 'Edit automation' : 'New automation'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="automation-name">Name</FieldLabel>
              <Input
                id="automation-name"
                value={form.name}
                placeholder="Fix CI when it breaks"
                onChange={(e) => field({ name: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="automation-trigger">When</FieldLabel>
              <Select
                id="automation-trigger"
                value={form.triggerKind}
                onChange={(e) => field({ triggerKind: e.target.value as FormState['triggerKind'] })}
              >
                <option value="pr_event">A pull request changes</option>
                <option value="channel_message">Someone posts in a channel</option>
                <option value="schedule">On a schedule</option>
              </Select>
            </Field>
            {form.triggerKind === 'pr_event' && (
              <>
                <Field>
                  <FieldLabel htmlFor="automation-pr-event">PR event</FieldLabel>
                  <Select
                    id="automation-pr-event"
                    value={form.prEvent}
                    onChange={(e) => field({ prEvent: e.target.value as FormState['prEvent'] })}
                  >
                    <option value="">Any PR event</option>
                    {PR_EVENT_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="automation-pr-repo">Repository filter</FieldLabel>
                  <Input
                    id="automation-pr-repo"
                    value={form.prRepo}
                    placeholder="owner/repo (optional — blank matches all)"
                    onChange={(e) => field({ prRepo: e.target.value })}
                  />
                </Field>
              </>
            )}
            {form.triggerKind === 'channel_message' && (
              <>
                <Field>
                  <FieldLabel htmlFor="automation-channel">Channel</FieldLabel>
                  <Input
                    id="automation-channel"
                    value={form.channel}
                    placeholder="team"
                    onChange={(e) => field({ channel: e.target.value })}
                  />
                  <FieldDescription>Only human posts trigger; agent posts never do.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="automation-contains">Only when the message contains</FieldLabel>
                  <Input
                    id="automation-contains"
                    value={form.contains}
                    placeholder="(optional)"
                    onChange={(e) => field({ contains: e.target.value })}
                  />
                </Field>
              </>
            )}
            {form.triggerKind === 'schedule' && (
              <div className="flex gap-3">
                <Field className="flex-1">
                  <FieldLabel htmlFor="automation-schedule-kind">Repeat</FieldLabel>
                  <Select
                    id="automation-schedule-kind"
                    value={form.scheduleKind}
                    onChange={(e) => field({ scheduleKind: e.target.value as FormState['scheduleKind'] })}
                  >
                    <option value="interval">Every N minutes</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </Select>
                </Field>
                {form.scheduleKind === 'interval' ? (
                  <Field className="flex-1">
                    <FieldLabel htmlFor="automation-minutes">Minutes</FieldLabel>
                    <Input
                      id="automation-minutes"
                      type="number"
                      min={1}
                      value={form.everyMinutes}
                      onChange={(e) => field({ everyMinutes: e.target.value })}
                    />
                  </Field>
                ) : (
                  <>
                    {form.scheduleKind === 'weekly' && (
                      <Field className="flex-1">
                        <FieldLabel htmlFor="automation-weekday">Day</FieldLabel>
                        <Select
                          id="automation-weekday"
                          value={form.dayOfWeek}
                          onChange={(e) => field({ dayOfWeek: e.target.value })}
                        >
                          {WEEKDAYS.map((d, i) => (
                            <option key={d} value={String(i)}>
                              {d}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    <Field className="flex-1">
                      <FieldLabel htmlFor="automation-time">Time</FieldLabel>
                      <Input
                        id="automation-time"
                        type="time"
                        value={form.time}
                        onChange={(e) => field({ time: e.target.value })}
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="automation-agent">Wake agent</FieldLabel>
              <Select id="automation-agent" value={form.agentId} onChange={(e) => field({ agentId: e.target.value })}>
                {agents.length === 0 && <option value="">No agents on the roster yet</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="automation-instruction">With the instruction</FieldLabel>
              <Textarea
                id="automation-instruction"
                rows={3}
                value={form.instruction}
                placeholder="Read the failure, fix it, and push."
                onChange={(e) => field({ instruction: e.target.value })}
              />
              <FieldDescription>
                Delivered verbatim in the agent&apos;s wakeup, together with what triggered it.
              </FieldDescription>
            </Field>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!submittable} onClick={() => void submit()}>
              {dialog.mode === 'edit' ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete automation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” will stop firing. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
AutomationsSection.displayName = 'AutomationsSection';
