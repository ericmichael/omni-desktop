import React from 'react'

export type TaskSummary = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: string[]
}

const MAX_VISIBLE = 8

const DOT_CLASS: Record<TaskSummary['status'], string> = {
  pending: 'bg-textSubtle/50',
  in_progress: 'bg-brand',
  completed: 'bg-successGreen',
}

// Docked task panel rendered just above the input. Mirrors the upstream
// omniagents web/ink layout: header counts, live status line for the
// active task, then a compact list of rows. Returns null when empty so
// the message area reclaims the space.
export function Tasks({ tasks }: { tasks: TaskSummary[] }) {
  if (!tasks || tasks.length === 0) {
return null
}

  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const pending = tasks.filter(t => t.status === 'pending')
  const completed = tasks.filter(t => t.status === 'completed')
  const ordered = [...inProgress, ...pending, ...completed]
  const visible = ordered.slice(0, MAX_VISIBLE)
  const overflow = ordered.length - visible.length
  const live = inProgress[0]

  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 p-2.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span className="font-medium text-textPrimary">Tasks</span>
          <span aria-hidden>·</span>
          <span><span className="text-brand">{inProgress.length}</span> active</span>
          <span aria-hidden>·</span>
          <span>{pending.length} pending</span>
          <span aria-hidden>·</span>
          <span><span className="text-successGreen">{completed.length}</span> done</span>
        </div>
        {live ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-brand">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand animate-pulse flex-shrink-0" />
            <span className="italic text-shimmer truncate">
              {live.activeForm || live.subject}
            </span>
          </div>
        ) : null}
        {visible.length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {visible.map(t => {
              const blockers = t.blockedBy ?? []
              const isBlocked = blockers.length > 0
              const isDone = t.status === 'completed'
              return (
                <li key={t.id} className="flex items-center gap-2 text-xs leading-5">
                  <span
                    className={[
                      'inline-block w-1.5 h-1.5 rounded-full flex-shrink-0',
                      DOT_CLASS[t.status],
                    ].join(' ')}
                    aria-hidden
                  />
                  <span className="text-textSubtle font-mono">#{t.id}</span>
                  <span
                    className={[
                      'min-w-0 truncate',
                      isDone ? 'text-textSubtle line-through' : 'text-textPrimary',
                    ].join(' ')}
                  >
                    {t.subject}
                  </span>
                  {isBlocked ? (
                    <span className="text-warningOrange whitespace-nowrap">
                      › blocked by #{blockers.join(', #')}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {overflow > 0 ? (
          <div className="mt-1 text-[11px] text-textSubtle">… +{overflow} more</div>
        ) : null}
      </div>
    </div>
  )
}
