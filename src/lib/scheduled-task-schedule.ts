import type { ScheduledTaskSchedule } from '@/shared/types';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CATCH_UP_WINDOW_MS = 7 * DAY_MS;

export function nextScheduledTaskRun(schedule: ScheduledTaskSchedule, afterMs: number = Date.now()): number | null {
  if (schedule.kind === 'manual') {
    return null;
  }
  if (schedule.kind === 'interval') {
    return afterMs + Math.max(1, Math.floor(schedule.everyMinutes)) * MINUTE_MS;
  }

  const [hour, minute] = parseTime(schedule.time);
  const candidate = new Date(afterMs);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= afterMs) {
    candidate.setDate(candidate.getDate() + 1);
  }

  while (!dateMatchesSchedule(candidate, schedule)) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

export function shouldCatchUpScheduledTask(nextRunAt: number | null | undefined, nowMs: number = Date.now()): boolean {
  return typeof nextRunAt === 'number' && nextRunAt <= nowMs && nowMs - nextRunAt <= CATCH_UP_WINDOW_MS;
}

export function mostRecentMissedScheduledTaskRun(
  schedule: ScheduledTaskSchedule,
  nextRunAt: number | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (schedule.kind === 'manual' || typeof nextRunAt !== 'number' || nextRunAt > nowMs) {
    return null;
  }

  if (schedule.kind === 'interval') {
    const intervalMs = Math.max(1, Math.floor(schedule.everyMinutes)) * MINUTE_MS;
    const missedIntervals = Math.floor((nowMs - nextRunAt) / intervalMs);
    const missedRunAt = nextRunAt + missedIntervals * intervalMs;
    return shouldCatchUpScheduledTask(missedRunAt, nowMs) ? missedRunAt : null;
  }

  let missedRunAt: number | null = null;
  const scanAfter = Math.max(nextRunAt - 1, nowMs - CATCH_UP_WINDOW_MS - DAY_MS);
  const firstCandidate = nextScheduledTaskRun(schedule, scanAfter);
  if (firstCandidate === null) {
    return null;
  }
  let candidate = firstCandidate;
  while (candidate <= nowMs) {
    if (candidate >= nextRunAt && shouldCatchUpScheduledTask(candidate, nowMs)) {
      missedRunAt = candidate;
    }
    const next = nextScheduledTaskRun(schedule, candidate);
    if (next === null || next <= candidate) {
      break;
    }
    candidate = next;
  }

  return missedRunAt;
}

export function normalizeScheduledTaskTime(value: string): string {
  const [hour, minute] = parseTime(value);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function dateMatchesSchedule(date: Date, schedule: ScheduledTaskSchedule): boolean {
  if (schedule.kind === 'daily') {
    const day = date.getDay();
    return !schedule.weekdaysOnly || (day >= 1 && day <= 5);
  }
  if (schedule.kind === 'weekly') {
    return date.getDay() === schedule.dayOfWeek;
  }
  return true;
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error('Time must be in HH:MM format');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Time must be in HH:MM format');
  }
  return [hour, minute];
}
