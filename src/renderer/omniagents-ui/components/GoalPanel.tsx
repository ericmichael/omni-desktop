import React from 'react'

// Server payload from omni-code's /goal autopilot loop (server_functions/goal.py).
// snapshot=null means no goal is set on this session (panel renders nothing).
// "paused" is a non-terminal hold state — the periodic tick is off but
// the goal can be resumed via /goal.resume.
export type GoalSnapshot = {
  goal: string
  turn: number
  max_turns: number
  tick_interval?: number
  last_reason: string | null
  status: 'active' | 'completed' | 'cancelled' | 'paused'
  started_at: number
  completion_reason: string | null
  // Auditable artifact attached on terminal states (achieved/blocked).
  evidence?: string | null
}

const GOAL_TRUNCATE = 100

function shortGoal(goal: string, max: number): string {
  const oneLine = goal.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max - 1) + '…'
}

function dotClass(status: GoalSnapshot['status']): string {
  if (status === 'active') return 'bg-brand animate-pulse'
  if (status === 'completed') return 'bg-successGreen'
  if (status === 'paused') return 'bg-warningOrange'
  return 'bg-errorRed'
}

// Compact single-line docked panel for the /goal autopilot loop. Mirrors
// the ink TUI's Goal.tsx contract:
//   Active:    ● goal · <text>
//   Completed: ● goal · <text> · completed
//   Cancelled: ● goal · <text> · cancelled
export function GoalPanel({ snapshot, onDismiss }: { snapshot: GoalSnapshot | null; onDismiss?: () => void }) {
  if (!snapshot) return null
  const terminal = snapshot.status === 'completed' || snapshot.status === 'cancelled'
  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 px-2.5 py-1.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span
            className={['inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(snapshot.status)].join(' ')}
            aria-hidden
          />
          <span className="font-medium text-textPrimary">goal</span>
          <span aria-hidden>·</span>
          <span className="truncate min-w-0 text-textPrimary" title={snapshot.goal}>
            {shortGoal(snapshot.goal, GOAL_TRUNCATE)}
          </span>
          {snapshot.status !== 'active' && (
            <span
              className={[
                'ml-auto whitespace-nowrap',
                snapshot.status === 'completed'
                  ? 'text-successGreen'
                  : snapshot.status === 'paused'
                    ? 'text-warningOrange'
                    : 'text-errorRed',
              ].join(' ')}
            >
              {snapshot.status}
            </span>
          )}
          {terminal && onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="ml-1 text-textSubtle hover:text-textPrimary transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt"
              title="Dismiss goal status"
              aria-label="Dismiss goal status"
            >
              dismiss
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
