/**
 * Pure trigger-matching and formatting for automations (`AutomationManager`
 * in `src/main/automation-manager.ts`): one event-driven rule = when
 * <trigger> fires, wake <resident> with an instruction.
 *
 * Deliberately NOT a step engine. Buzz-style workflow steps are an opaque
 * second execution model; here the woken resident IS the workflow engine and
 * its day session is the run trace. These helpers only answer "did this
 * event match this rule?" and "what does the wakeup say?".
 */
import type { PullRequestWatchEvent } from '@/lib/pull-request-watch';
import { isHumanParticipant } from '@/lib/resident-agent';
import type { Automation, AutomationTrigger } from '@/shared/types';

/**
 * Message-triggered rules can't fire more often than this. The loop guard is
 * primarily "human posts only", but a cooldown also keeps a chatty channel
 * from turning one rule into a wakeup storm.
 */
export const MESSAGE_TRIGGER_COOLDOWN_MS = 60_000;

/** Does a PR watch event match a `pr_event` trigger's filters? */
export function matchesPrEvent(
  trigger: Extract<AutomationTrigger, { kind: 'pr_event' }>,
  ev: Pick<PullRequestWatchEvent, 'kind' | 'repo'>
): boolean {
  if (trigger.events && trigger.events.length > 0 && !trigger.events.includes(ev.kind)) {
    return false;
  }
  const repo = trigger.repo?.trim().toLowerCase();
  if (repo && !ev.repo.toLowerCase().includes(repo)) {
    return false;
  }
  return true;
}

/**
 * Does a chat message match a `channel_message` trigger? Only HUMAN posts
 * trigger — an agent post firing an automation that wakes an agent that posts
 * is the loop this rule exists to prevent (buzz excludes workflow-authored
 * events from workflow triggers for the same reason).
 */
export function matchesChannelMessage(
  trigger: Extract<AutomationTrigger, { kind: 'channel_message' }>,
  msg: { channel: string; from: string; text: string }
): boolean {
  if (msg.channel !== trigger.channel) {
    return false;
  }
  if (!isHumanParticipant(msg.from)) {
    return false;
  }
  const needle = trigger.contains?.trim().toLowerCase();
  if (needle && !msg.text.toLowerCase().includes(needle)) {
    return false;
  }
  return true;
}

/** Cooldown gate for message triggers (pure so the manager stays testable). */
export function messageCooldownActive(lastFiredAt: number | undefined, nowMs: number): boolean {
  return lastFiredAt !== undefined && nowMs - lastFiredAt < MESSAGE_TRIGGER_COOLDOWN_MS;
}

/** One-line human-readable description of a trigger, for cards and summaries. */
export function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case 'pr_event': {
      const events = trigger.events?.length ? trigger.events.join('/') : 'any PR event';
      return `on ${events}${trigger.repo ? ` in ${trigger.repo}` : ''}`;
    }
    case 'channel_message':
      return `on a message in #${trigger.channel}${trigger.contains ? ` containing "${trigger.contains}"` : ''}`;
    case 'schedule': {
      const s = trigger.schedule;
      if (s.kind === 'interval') {
        return `every ${s.everyMinutes}m`;
      }
      if (s.kind === 'daily') {
        return `daily at ${s.time}${s.weekdaysOnly ? ' (weekdays)' : ''}`;
      }
      if (s.kind === 'weekly') {
        return `weekly on day ${s.dayOfWeek} at ${s.time}`;
      }
      return 'manual only';
    }
  }
}

/**
 * The wakeup detail for a fired automation: why it fired, then the standing
 * instruction verbatim. Mirrors the `assignment` idiom — a delta plus what to
 * do; the agent pulls everything else through its tools.
 */
export function automationFireDetail(automation: Pick<Automation, 'name' | 'instruction'>, cause: string): string {
  return `automation "${automation.name}" fired (${cause}) — your standing instruction: ${automation.instruction}`;
}
