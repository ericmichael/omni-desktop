import React, { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ActivityGroupData } from './activityGroup'
import { computeGroupSummary, formatGroupSummary } from './activityGroup'
import { ToolCard, formatArgsPreview } from './MessageList'
import type { ToolItem } from './MessageList'

export function ActivityGroup({ group, statusText }: { group: ActivityGroupData; statusText?: string }) {
  // Singleton without grouping — render as plain ToolCard
  if (group.tools.length === 1 && !group.runId) {
    return <ToolCard item={group.tools[0]} />
  }

  return <GroupCard group={group} statusText={statusText} />
}

function GroupCard({ group, statusText }: { group: ActivityGroupData; statusText?: string }) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => computeGroupSummary(group.tools), [group.tools])
  const summaryText = useMemo(() => formatGroupSummary(summary), [summary])
  const latest = group.tools[group.tools.length - 1]
  const preview = formatArgsPreview(latest?.input || '', 60)

  return (
    <motion.div layout className="space-y-2">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-3 rounded-md bg-bgCardAlt text-sm hover:bg-bgColumn transition-colors text-left min-w-0"
      >
        {group.isRunning ? (
          <>
            <span className="inline-block w-2 h-2 rounded-full bg-warningOrange animate-pulse flex-shrink-0" />
            <div className="flex-1 min-w-0 overflow-hidden">
              <AnimatePresence mode="wait">
                {statusText ? (
                  <motion.span
                    key={'status-' + statusText}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className="text-textSubtle truncate"
                  >
                    {statusText}
                  </motion.span>
                ) : (
                  <motion.span
                    key={latest?.call_id || group.tools.length}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className="inline-flex items-center gap-1 text-textSubtle truncate"
                  >
                    <span className="font-medium text-textPrimary">{latest?.tool}</span>
                    {preview ? <span className="truncate">({preview})</span> : null}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <span className="text-xs text-textSubtle flex-shrink-0 tabular-nums">{group.tools.length}</span>
          </>
        ) : (
          <>
            <span className="flex-1 min-w-0 text-textSubtle truncate">{summaryText}</span>
          </>
        )}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          className={['text-textSubtle transition-transform flex-shrink-0', expanded ? 'rotate-180' : ''].join(' ')}
        >
          <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pl-4 border-l-2 border-bgCardAlt ml-3">
              {group.tools.map((t, i) => (
                <ToolCard key={t.call_id || i} item={t} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
