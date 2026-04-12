import React, { useCallback, useMemo, useRef, useState } from 'react'
import { PaperclipIcon, FolderIcon, MonitorIcon, MicIcon, ArrowUpIcon, SquareIcon, XIcon, Loader2Icon, LockIcon } from 'lucide-react'
import { PromptInput, PromptInputTextarea, PromptInputActions } from './promptkit/PromptInput'
import { VoiceModal } from './VoiceModal'

export function Input({ disabled, thinking, onStop, onSubmit, voiceEnabled, workspacePath, workspaceLocked, onWorkspaceClick, sandboxLabel, sandboxLoading, sessionId, onVoiceSessionCreated, onVoiceClose }:
  { disabled?: boolean; thinking?: boolean; onStop?: () => void; onSubmit: (text: string, files?: File[]) => void; voiceEnabled?: boolean; workspacePath?: string | null; workspaceLocked?: boolean; onWorkspaceClick?: () => void; sandboxLabel?: string; sandboxLoading?: boolean; sessionId?: string; onVoiceSessionCreated?: (id: string) => void; onVoiceClose?: () => void }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [historyDraft, setHistoryDraft] = useState('')
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const canSend = useMemo(() => !disabled && (text.trim().length > 0 || files.length > 0), [disabled, text, files])

  const insertNewlineAtCursor = useCallback((el?: HTMLTextAreaElement) => {
    const target = el ?? taRef.current
    if (!target) return
    const start = target.selectionStart ?? text.length
    const end = target.selectionEnd ?? text.length
    const next = text.slice(0, start) + '\n' + text.slice(end)
    setText(next)
    const pos = start + 1
    requestAnimationFrame(() => {
      try { target.setSelectionRange(pos, pos) } catch {}
    })
  }, [text])

  const handleSubmit = useCallback(() => {
    const t = text.trim()
    if (!t && files.length === 0) return
    onSubmit(t, files)
    setHistory(h => h.length && h[h.length - 1] === t ? h : [...h, t])
    setHistoryIndex(0)
    setHistoryDraft('')
    setText('')
    setFiles([])
  }, [text, files, onSubmit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (thinking && onStop) {
        onStop()
      }
      return
    }
    if (e.key === 'Enter') {
      if (e.shiftKey || e.altKey) {
        e.preventDefault()
        insertNewlineAtCursor(e.currentTarget)
        return
      }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'j')) {
      e.preventDefault()
      insertNewlineAtCursor(e.currentTarget)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const el = e.currentTarget
      const caretAtStart = (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0
      const caretAtEnd = (el.selectionStart ?? 0) === text.length && (el.selectionEnd ?? 0) === text.length
      if (e.key === 'ArrowUp' && caretAtStart) {
        e.preventDefault()
        if (historyIndex === 0) setHistoryDraft(text)
        const nextIndex = Math.min(history.length, historyIndex + 1)
        setHistoryIndex(nextIndex)
        const replacement = nextIndex > 0 ? history[history.length - nextIndex] : historyDraft
        if (replacement != null) setText(replacement)
        requestAnimationFrame(() => {
          try { el.setSelectionRange(0, 0) } catch {}
        })
      } else if (e.key === 'ArrowDown' && caretAtEnd) {
        e.preventDefault()
        const nextIndex = Math.max(0, historyIndex - 1)
        setHistoryIndex(nextIndex)
        const replacement = nextIndex > 0 ? history[history.length - nextIndex] : historyDraft
        if (replacement != null) setText(replacement)
        requestAnimationFrame(() => {
          const pos = (replacement ?? '').length
          try { el.setSelectionRange(pos, pos) } catch {}
        })
      }
    }
  }, [text, history, historyIndex, historyDraft, handleSubmit, insertNewlineAtCursor, thinking, onStop])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          const ext = file.type.split('/')[1] || 'png'
          const named = new File([file], `paste-${Date.now()}.${ext}`, { type: file.type })
          imageFiles.push(named)
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      setFiles(prev => [...prev, ...imageFiles])
    }
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : []
    setFiles(list)
  }, [])

  return (
    <div>
      <div className="container-chat px-3 py-3">
        <PromptInput
          isLoading={!!thinking}
          value={text}
          onValueChange={setText}
          onSubmit={handleSubmit}
          disabled={disabled}
          className=""
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-2 px-2" onClick={(e) => e.stopPropagation()}>
              {files.map((f, i) => (
                f.type.startsWith('image/') ? (
                  <div key={i} className="relative group">
                    <img src={URL.createObjectURL(f)} alt="" className="h-20 max-w-[160px] rounded-lg object-cover border border-border" />
                    <button onClick={() => {
                      setFiles(prev => prev.filter((_, idx) => idx !== i))
                      if (fileInputRef.current) fileInputRef.current.value = ''
                    }} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <XIcon size={12} />
                    </button>
                  </div>
                ) : (
                  <div key={i} className="bg-card flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                    <PaperclipIcon size={16} className="text-foreground" />
                    <span className="max-w-[120px] truncate text-foreground" title={f.name}>{f.name}</span>
                    <button onClick={() => {
                      setFiles(prev => prev.filter((_, idx) => idx !== i))
                      if (fileInputRef.current) fileInputRef.current.value = ''
                    }} className="hover:bg-accent rounded-full p-1">
                      <XIcon size={16} className="text-foreground" />
                    </button>
                  </div>
                )
              ))}
            </div>
          )}

          <PromptInputTextarea
            placeholder="How can I help you today?"
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="max-h-[50vh]"
            disabled={disabled}
          />

          <PromptInputActions className="flex items-center justify-between gap-1 sm:gap-2 pt-2 px-2">
            <div className="flex items-center gap-1 min-w-0">
              <label
                htmlFor="file-upload"
                onClick={(e) => e.stopPropagation()}
                className="hover:bg-accent/50 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-2xl"
                aria-label="Attach files"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFilesSelected}
                  className="hidden"
                  id="file-upload"
                />
                <PaperclipIcon size={20} className="text-foreground" />
              </label>

              {workspacePath !== undefined && (
                <button
                  onClick={workspaceLocked ? undefined : onWorkspaceClick}
                  disabled={workspaceLocked}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors min-w-0 ${
                    workspaceLocked
                      ? 'text-muted-foreground cursor-default'
                      : 'text-secondary-foreground hover:bg-accent/50 cursor-pointer'
                  }`}
                  title={workspacePath || 'Select workspace'}
                >
                  <FolderIcon size={14} className={`shrink-0 ${workspaceLocked ? 'text-muted-foreground' : 'text-primary'}`} />
                  <span className="max-w-[120px] sm:max-w-[200px] truncate">
                    {workspacePath ? workspacePath.split('/').pop() || workspacePath : 'Select workspace'}
                  </span>
                  {workspaceLocked && (
                    <LockIcon size={10} className="text-muted-foreground flex-shrink-0" />
                  )}
                </button>
              )}

              {sandboxLabel && (
                <div
                  className="hidden sm:flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-secondary-foreground hover:bg-accent/50 transition-colors"
                  title={`Sandbox: ${sandboxLabel}`}
                >
                  {sandboxLoading ? (
                    <Loader2Icon size={14} className="text-muted-foreground animate-spin" />
                  ) : null}
                  <MonitorIcon size={14} className="text-secondary-foreground" />
                  <span>{sandboxLabel}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {voiceEnabled ? (
                <button
                  type="button"
                  onClick={() => setIsVoiceModalOpen(true)}
                  className="hover:bg-accent/50 flex h-8 w-8 items-center justify-center rounded-2xl"
                  aria-label="Voice mode"
                >
                  <MicIcon size={20} className="text-foreground" />
                </button>
              ) : null}

              {!thinking ? (
              <button
                type="button"
                disabled={!canSend}
                onClick={handleSubmit}
                className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center disabled:bg-secondary disabled:text-muted-foreground hover:brightness-110 focus:outline-none shadow-sm"
                aria-label="Send"
                title="Send (Enter)"
              >
                <ArrowUpIcon size={20} className="pointer-events-none" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onStop}
                className="h-8 w-8 rounded-full bg-destructive text-primary-foreground flex items-center justify-center hover:brightness-110 focus:outline-none shadow-sm"
                aria-label="Stop"
                title="Stop"
              >
                <SquareIcon size={20} className="pointer-events-none" />
              </button>
              )}
            </div>
          </PromptInputActions>
        </PromptInput>
      </div>

      {isVoiceModalOpen && (
        <VoiceModal
          isOpen={isVoiceModalOpen}
          sessionId={sessionId}
          onSessionCreated={onVoiceSessionCreated}
          onClose={() => { setIsVoiceModalOpen(false); onVoiceClose?.(); }}
        />
      )}
    </div>
  )
}
