import React, { useCallback, useEffect, useRef, useState } from 'react'

export type BashJobSummary = {
  job_id: string
  pid: number
  command: string
  running: boolean
  exit_code: number | null
  wall_time_ms: number
  started_at?: number
  log_path?: string
  cwd?: string
}

export type BashJobsTailResult = {
  ok: boolean
  text?: string
  total_lines?: number
  job?: BashJobSummary
  error?: string
  message?: string
}

export type BashJobsKillResult = {
  ok: boolean
  signal_sent?: 'none' | 'SIGTERM' | 'SIGKILL'
  job?: BashJobSummary
  snapshot?: BashJobSummary[]
  error?: string
}

const MAX_VISIBLE = 5
const COMMAND_TRUNCATE = 80
const TAIL_DEFAULT_LINES = 200

function shortCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= COMMAND_TRUNCATE) {
return oneLine
}
  return `${oneLine.slice(0, COMMAND_TRUNCATE - 1)  }…`
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
return `${ms}ms`
}
  const seconds = ms / 1000
  if (seconds < 60) {
return `${seconds.toFixed(1)}s`
}
  const minutes = Math.floor(seconds / 60)
  const rem = Math.floor(seconds - minutes * 60)
  return `${minutes}m${rem.toString().padStart(2, '0')}s`
}

function liveElapsedMs(job: BashJobSummary, nowMs: number): number {
  if (!job.running || !job.started_at) {
return job.wall_time_ms
}
  const elapsed = nowMs - job.started_at * 1000
  return Math.max(elapsed, job.wall_time_ms)
}

function dotClass(job: BashJobSummary): string {
  if (job.running) {
return 'bg-primary animate-pulse'
}
  return job.exit_code === 0 ? 'bg-successGreen' : 'bg-errorRed'
}

const stopPropagation: React.MouseEventHandler = (e) => {
  e.stopPropagation()
}

type BashJobRowProps = {
  job: BashJobSummary
  nowMs: number
  isKilling: boolean
  onShowLogs?: (jobId: string) => void
  onKill?: (jobId: string) => void
  onDismiss?: (jobId: string) => void
}

// One row of the docked panel. Pulled out of the parent map so the per-row
// callbacks can use `.bind(null, jobId)` instead of inline arrows — keeps
// `react/jsx-no-bind` satisfied without growing the parent component.
function BashJobRow({ job, nowMs, isKilling, onShowLogs, onKill, onDismiss }: BashJobRowProps) {
  const elapsed = formatElapsed(liveElapsedMs(job, nowMs))
  const tail = job.running ? elapsed : `exit ${job.exit_code} · ${elapsed}`
  return (
    <li className="flex items-center gap-2 text-xs leading-5">
      <span
        className={['inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(job)].join(' ')}
        aria-hidden
      />
      <span className="text-textSubtle font-mono">{job.job_id}</span>
      <span
        className={[
          'min-w-0 truncate font-mono',
          job.running ? 'text-textPrimary' : 'text-textSubtle line-through',
        ].join(' ')}
        title={job.command}
      >
        {shortCommand(job.command)}
      </span>
      <span className="ml-auto text-textSubtle whitespace-nowrap">{tail}</span>
      {onShowLogs ? (
        <button
          type="button"
          onClick={onShowLogs.bind(null, job.job_id)}
          className="text-textSubtle hover:text-textPrimary transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt"
          title="View recent log output"
        >
          logs
        </button>
      ) : null}
      {onKill && job.running ? (
        <button
          type="button"
          disabled={isKilling}
          onClick={onKill.bind(null, job.job_id)}
          className="text-textSubtle hover:text-errorRed transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Terminate ${job.job_id} (SIGTERM, then SIGKILL)`}
          aria-label={`Terminate job ${job.job_id}`}
        >
          {isKilling ? '…' : '✕'}
        </button>
      ) : null}
      {onDismiss && !job.running ? (
        <button
          type="button"
          onClick={onDismiss.bind(null, job.job_id)}
          className="text-textSubtle hover:text-textPrimary transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt"
          title={`Dismiss job ${job.job_id}`}
          aria-label={`Dismiss job ${job.job_id}`}
        >
          dismiss
        </button>
      ) : null}
    </li>
  )
}

type Props = {
  jobs: BashJobSummary[]
  onKill?: (job_id: string) => Promise<BashJobsKillResult>
  onTail?: (job_id: string, lines?: number) => Promise<BashJobsTailResult>
  onDismiss?: (job_id: string) => void
  // Optional: fired once on mount when at least one job is running, so the
  // server-side sweeper has a chance to capture a service handle and start
  // pushing ``ui.bash_jobs.update`` broadcasts on natural exits.
  onWarmup?: () => Promise<unknown>
}

export function BashJobs({ jobs, onKill, onTail, onWarmup, onDismiss }: Props) {
  // 1Hz tick while at least one job is running so elapsed time updates.
  const [, setNowTick] = useState(0)
  const anyRunning = jobs.some(j => j.running)
  useEffect(() => {
    if (!anyRunning) {
return
}
    const id = window.setInterval(() => setNowTick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [anyRunning])

  // One-shot warmup: when running jobs first appear (mount or after spawn),
  // fire onWarmup so the server-side sweeper captures a service handle.
  const warmedUpRef = useRef(false)
  useEffect(() => {
    if (!anyRunning) {
      warmedUpRef.current = false
      return
    }
    if (warmedUpRef.current || !onWarmup) {
return
}
    warmedUpRef.current = true
    onWarmup().catch(() => {
      warmedUpRef.current = false
    })
  }, [anyRunning, onWarmup])

  const [killing, setKilling] = useState<Set<string>>(new Set())
  const [logsModalJobId, setLogsModalJobId] = useState<string | null>(null)
  const [killError, setKillError] = useState<string | null>(null)

  const handleKill = useCallback(async (job_id: string) => {
    if (!onKill) {
return
}
    if (!window.confirm(`Terminate background job ${job_id}?`)) {
return
}
    setKillError(null)
    setKilling(prev => {
      const next = new Set(prev)
      next.add(job_id)
      return next
    })
    try {
      const res = await onKill(job_id)
      if (!res.ok) {
        setKillError(`Failed to kill ${job_id}: ${res.error ?? 'unknown error'}`)
      }
    } catch (e) {
      setKillError(`Failed to kill ${job_id}: ${(e as Error).message ?? String(e)}`)
    } finally {
      setKilling(prev => {
        const next = new Set(prev)
        next.delete(job_id)
        return next
      })
    }
  }, [onKill])

  const handleShowLogs = useCallback((jobId: string) => setLogsModalJobId(jobId), [])
  const handleCloseLogs = useCallback(() => setLogsModalJobId(null), [])

  if (!jobs || jobs.length === 0) {
return null
}

  const running = jobs.filter(j => j.running)
  const exited = jobs.filter(j => !j.running)
  const failed = exited.filter(j => (j.exit_code ?? 0) !== 0)
  const succeeded = exited.length - failed.length

  const ordered = [
    ...running,
    ...exited.slice().sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)),
  ]
  const visible = ordered.slice(0, MAX_VISIBLE)
  const overflow = ordered.length - visible.length
  const nowMs = Date.now()

  const rowShowLogs = onTail ? handleShowLogs : undefined
  const rowKill = onKill ? handleKill : undefined

  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 p-2.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span className="font-medium text-textPrimary">Bash jobs</span>
          <span aria-hidden>·</span>
          <span><span className="text-brand">{running.length}</span> running</span>
          <span aria-hidden>·</span>
          <span><span className="text-successGreen">{succeeded}</span> done</span>
          <span aria-hidden>·</span>
          <span><span className="text-errorRed">{failed.length}</span> failed</span>
        </div>
        {killError ? (
          <div className="mt-1 text-[11px] text-errorRed">{killError}</div>
        ) : null}
        {visible.length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {visible.map(j => (
              <BashJobRow
                key={j.job_id}
                job={j}
                nowMs={nowMs}
                isKilling={killing.has(j.job_id)}
                onShowLogs={rowShowLogs}
                onKill={rowKill}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        ) : null}
        {overflow > 0 ? (
          <div className="mt-1 text-[11px] text-textSubtle">… +{overflow} more</div>
        ) : null}
      </div>

      {logsModalJobId && onTail ? (
        <BashJobLogsModal
          jobId={logsModalJobId}
          onClose={handleCloseLogs}
          onTail={onTail}
        />
      ) : null}
    </div>
  )
}

type ModalProps = {
  jobId: string
  onClose: () => void
  onTail: (job_id: string, lines?: number) => Promise<BashJobsTailResult>
}

function BashJobLogsModal({ jobId, onClose, onTail }: ModalProps) {
  const [text, setText] = useState<string>('')
  const [meta, setMeta] = useState<BashJobsTailResult | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await onTail(jobId, TAIL_DEFAULT_LINES)
      setMeta(res)
      if (!res.ok) {
        setError(res.message ?? res.error ?? 'Failed to read logs')
        setText('')
      } else {
        setText(res.text ?? '')
      }
    } catch (e) {
      setError((e as Error).message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [jobId, onTail])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
onClose()
}
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const job = meta?.job
  const total = meta?.total_lines ?? 0
  const shown = text ? text.split('\n').length : 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-bgCard border border-bgCardAlt rounded-lg shadow-xl w-[min(900px,90vw)] max-h-[80vh] flex flex-col"
        onClick={stopPropagation}
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-bgCardAlt text-xs">
          <span className="font-mono text-textPrimary">{jobId}</span>
          {job ? (
            <span className="text-textSubtle">
              {job.running ? 'running' : `exited(${job.exit_code})`} · {formatElapsed(job.wall_time_ms)}
            </span>
          ) : null}
          <span className="ml-auto text-textSubtle">
            {shown} of {total} lines
          </span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-textSubtle hover:text-textPrimary px-2 py-0.5 rounded hover:bg-bgCardAlt disabled:opacity-50"
            title="Refresh"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-textSubtle hover:text-textPrimary px-2 py-0.5 rounded hover:bg-bgCardAlt"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre text-textPrimary">
          {loading ? (
            <span className="text-textSubtle italic">Loading…</span>
          ) : error ? (
            <span className="text-errorRed">{error}</span>
          ) : text ? (
            text
          ) : (
            <span className="text-textSubtle italic">(no log output)</span>
          )}
        </div>
        {job?.log_path ? (
          <div className="px-4 py-2 border-t border-bgCardAlt text-[11px] text-textSubtle font-mono truncate">
            {job.log_path}
          </div>
        ) : null}
      </div>
    </div>
  )
}
