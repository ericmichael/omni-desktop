import React, { useCallback, useEffect, useState } from 'react'
import { useRPCClient } from '../rpc-context'

type DirEntry = {
  name: string
  path: string
  is_dir: boolean
}

export function WorkspacePicker({
  sessionId,
  initialPath,
  onSelect,
  onClose,
}: {
  sessionId?: string
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const client = useRPCClient()
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [manualInput, setManualInput] = useState('')
  const [editingPath, setEditingPath] = useState(false)

  const load = useCallback(async (path?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.serverCall('fs_list_dir', {
        path: path || undefined,
        include_files: false,
        ignore_hidden: true,
      }, sessionId) as any
      setCurrentPath(res.path || null)
      setParentPath(res.parent || null)
      setManualInput(res.path || '')
      const list: DirEntry[] = []
      if (Array.isArray(res.entries)) {
        for (const e of res.entries) {
          if (e && typeof e === 'object') {
            list.push({ name: e.name, path: e.path, is_dir: !!e.is_dir })
          }
        }
      }
      setEntries(list)
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [client, sessionId])

  useEffect(() => {
    (async () => {
      let start = initialPath
      if (!start) {
        try {
          const res = await client.serverCall('fs_get_cwd', {}, sessionId) as any
          start = res?.path
        } catch {}
      }
      if (!start) {
        try {
          const res = await client.serverCall('fs_get_home', {}, sessionId) as any
          start = res?.path
        } catch {}
      }
      await load(start)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualGo = useCallback(() => {
    const trimmed = manualInput.trim()
    if (trimmed) {
      load(trimmed)
      setEditingPath(false)
    }
  }, [manualInput, load])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bgMain border border-bgCardAlt rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-bgCardAlt">
          <h2 className="text-sm font-semibold text-textHeading">Choose Workspace</h2>
          <button
            onClick={onClose}
            className="text-textSubtle hover:text-textHeading p-1 rounded"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-bgCardAlt">
          <button
            onClick={() => parentPath && load(parentPath)}
            disabled={!parentPath}
            className="flex-shrink-0 text-textSubtle hover:text-textHeading disabled:opacity-30 p-1 rounded"
            aria-label="Go up"
            title="Parent directory"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={async () => {
              try {
                const res = await client.serverCall('fs_get_home', {}, sessionId) as any
                if (res?.path) load(res.path)
              } catch {}
            }}
            className="flex-shrink-0 text-textSubtle hover:text-textHeading p-1 rounded"
            aria-label="Home"
            title="Home directory"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
          {editingPath ? (
            <form
              className="flex-1 flex items-center gap-1"
              onSubmit={(e) => { e.preventDefault(); handleManualGo() }}
            >
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onBlur={() => setEditingPath(false)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditingPath(false) }}
                autoFocus
                className="flex-1 bg-bgCard text-textHeading text-xs rounded px-2 py-1 border border-bgCardAlt outline-none focus:border-tweetBlue"
              />
            </form>
          ) : (
            <button
              onClick={() => setEditingPath(true)}
              className="flex-1 text-left text-xs text-textHeading truncate hover:underline cursor-text px-1"
              title={currentPath || ''}
            >
              {currentPath || '…'}
            </button>
          )}
        </div>

        {/* Entries list */}
        <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '50vh' }}>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-tweetBlue border-t-transparent" />
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-sm text-errorRed text-center">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-6 text-sm text-textSubtle text-center">No subdirectories</div>
          ) : (
            <div className="py-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => load(entry.path)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-bgCard/50 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" className="flex-shrink-0 text-tweetBlue" fill="currentColor">
                    <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                  <span className="text-sm text-textHeading truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-bgCardAlt">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-textSubtle hover:text-textHeading rounded-lg hover:bg-bgCard transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => currentPath && onSelect(currentPath)}
            disabled={!currentPath}
            className="px-4 py-1.5 text-sm font-medium bg-tweetBlue text-white rounded-lg hover:brightness-110 disabled:opacity-50 transition-all"
          >
            Use This Folder
          </button>
        </div>
      </div>
    </div>
  )
}
