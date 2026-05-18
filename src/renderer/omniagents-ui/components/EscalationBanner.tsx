import React from 'react'

export type EscalationInfo = {
  request_id: string
  message: string
  session_id?: string
  run_id?: string
}

type Props = {
  escalation: EscalationInfo | null
}

// Banner shown when the agent calls the ``escalate`` builtin (a
// blocking client-function tool). The agent's tool call is paused on
// our pending ``client_response``; the next non-slash message the user
// submits becomes the reply (see App.tsx handleSubmit interceptor).
// Renders nothing when no escalation is pending.
export function EscalationBanner({ escalation }: Props) {
  if (!escalation) {
    return null
  }

  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-warningOrange/60 bg-warningOrange/10 p-2.5">
        <div className="text-xs text-warningOrange font-medium">
          Agent escalated — your next message will be sent back as the reply.
        </div>
        <div className="mt-1 text-sm text-textPrimary">
          {escalation.message}
        </div>
      </div>
    </div>
  )
}
