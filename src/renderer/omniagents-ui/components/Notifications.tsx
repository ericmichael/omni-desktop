import React from 'react'

export type NotificationInfo = {
  id: string
  message: string
  timestamp: number
}

type Props = {
  notifications: NotificationInfo[]
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

// Docked notifications panel. Accumulates ``notify`` calls from the
// agent and persists them until the user explicitly dismisses them —
// long-running runs can drop many heads-ups; the user catches up at a
// glance and decides what to clear. Mirrors Tasks / BashJobs styling
// (same bgCardAlt card, brand-color accents).
export function Notifications({ notifications, onDismiss, onDismissAll }: Props) {
  if (!notifications || notifications.length === 0) {
    return null
  }

  const noun = notifications.length === 1 ? 'notification' : 'notifications'

  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 p-2.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span className="font-medium text-textPrimary">Notifications</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-brand">{notifications.length}</span> {noun}
          </span>
          <button
            type="button"
            onClick={onDismissAll}
            className="ml-auto text-textSubtle hover:text-textPrimary transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt"
            title="Dismiss all notifications"
          >
            dismiss all
          </button>
        </div>
        <ul className="mt-1.5 space-y-1">
          {notifications.map((n) => (
            <li
              key={n.id}
              className="flex items-start gap-2 text-xs leading-5"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0 mt-1.5"
                aria-hidden
              />
              <span className="min-w-0 flex-1 text-textPrimary">
                {n.message}
              </span>
              <button
                type="button"
                onClick={() => onDismiss(n.id)}
                className="text-textSubtle hover:text-errorRed transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt flex-shrink-0"
                title="Dismiss"
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
