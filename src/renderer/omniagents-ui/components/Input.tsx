import { useStore } from '@nanostores/react';
import {
  ArrowUpIcon,
  FolderIcon,
  LockIcon,
  MicIcon,
  MonitorIcon,
  PaperclipIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from 'lucide-react';
import React, { useCallback, useMemo, useRef, useState } from 'react';

import { configuredVoiceMode } from '@/lib/voice-mode';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';

import { LocalVoiceButton } from './LocalVoiceButton';
import { PromptInput, PromptInputActions, PromptInputTextarea } from './promptkit/PromptInput';
import { VoiceModal } from './VoiceModal';

/** Trailing path segment, tolerant of both `/` and `\` separators and trailing slashes. Falls back to the input when nothing would be left. */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const tail = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return tail || p;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Projectless chats run in a launcher-created per-session scratch directory
 *  (`Sessions/<uuid>`, `/workspace/<uuid>` in a container). That folder is an
 *  implementation detail, so the composer shows no folder chip for it — a
 *  generic "Workspace" label implied a real attached folder, and a raw UUID
 *  reads as a bug. Attaching a project is what gives a chat a real folder. */
function isSessionScratchPath(p: string): boolean {
  return UUID_RE.test(basename(p));
}

export function Input({
  disabled,
  thinking,
  onStop,
  onSubmit,
  onVoiceSubmit,
  voiceEnabled,
  speakRepliesEnabled,
  onSpeakRepliesChange,
  workspacePath,
  sandboxLabel,
  sandboxLocked,
  sandboxLoading,
  sandboxOptions,
  currentSandboxProfile,
  onSandboxChange,
  composerExtras,
  sessionId,
  onVoiceSessionCreated,
  onVoiceClose,
}: {
  disabled?: boolean;
  thinking?: boolean;
  onStop?: () => void;
  onSubmit: (text: string, files?: File[]) => void;
  onVoiceSubmit?: (text: string) => void;
  voiceEnabled?: boolean;
  speakRepliesEnabled?: boolean;
  onSpeakRepliesChange?: (enabled: boolean) => void;
  workspacePath?: string | null;
  sandboxLabel?: string;
  sandboxLocked?: boolean;
  sandboxLoading?: boolean;
  sandboxOptions?: { value: string; label: string }[];
  currentSandboxProfile?: string;
  onSandboxChange?: (value: string) => void;
  /** Extra chips rendered after the sandbox chip (e.g. attach-project). The
   *  chip row is the one home for column-context controls, pre- and
   *  post-launch, so callers pass the same node to ChatShell and the app. */
  composerExtras?: React.ReactNode;
  sessionId?: string;
  onVoiceSessionCreated?: (id: string) => void;
  onVoiceClose?: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyDraft, setHistoryDraft] = useState('');
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  // Which mic to show follows the configured mode, not availability: gating
  // the hosted button on `voiceEnabled` alone meant a credential existing was
  // enough to render it, so Voice = Off still showed a mic.
  const voiceMode = configuredVoiceMode(useStore(persistedStoreApi.$atom));
  const localVoiceSupported = voiceMode === 'local' && isLocalVoiceCapable();
  const hostedVoiceSupported = voiceMode === 'hosted' && Boolean(voiceEnabled);
  const speakerToggleLabel = speakRepliesEnabled ? 'Spoken replies on' : 'Spoken replies off';
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sandboxInteractive = !!sandboxOptions && sandboxOptions.length > 0 && !!onSandboxChange && !sandboxLocked;

  const handleSandboxSelect = useCallback(
    (value: string) => {
      if (value !== currentSandboxProfile) {
        onSandboxChange?.(value);
      }
    },
    [currentSandboxProfile, onSandboxChange]
  );

  const canSend = useMemo(() => !disabled && (text.trim().length > 0 || files.length > 0), [disabled, text, files]);

  const insertNewlineAtCursor = useCallback(
    (el?: HTMLTextAreaElement) => {
      const target = el ?? taRef.current;
      if (!target) {
        return;
      }
      const start = target.selectionStart ?? text.length;
      const end = target.selectionEnd ?? text.length;
      const next = `${text.slice(0, start)}\n${text.slice(end)}`;
      setText(next);
      const pos = start + 1;
      requestAnimationFrame(() => {
        try {
          target.setSelectionRange(pos, pos);
        } catch {}
      });
    },
    [text]
  );

  const handleSubmit = useCallback(() => {
    const t = text.trim();
    if (!t && files.length === 0) {
      return;
    }
    onSubmit(t, files);
    setHistory((h) => (h.length && h[h.length - 1] === t ? h : [...h, t]));
    setHistoryIndex(0);
    setHistoryDraft('');
    setText('');
    setFiles([]);
  }, [text, files, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (thinking && onStop) {
          onStop();
        }
        return;
      }
      if (e.key === 'Enter') {
        if (e.shiftKey || e.altKey) {
          e.preventDefault();
          insertNewlineAtCursor(e.currentTarget);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        insertNewlineAtCursor(e.currentTarget);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const el = e.currentTarget;
        const caretAtStart = (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0;
        const caretAtEnd = (el.selectionStart ?? 0) === text.length && (el.selectionEnd ?? 0) === text.length;
        if (e.key === 'ArrowUp' && caretAtStart) {
          e.preventDefault();
          if (historyIndex === 0) {
            setHistoryDraft(text);
          }
          const nextIndex = Math.min(history.length, historyIndex + 1);
          setHistoryIndex(nextIndex);
          const replacement = nextIndex > 0 ? history[history.length - nextIndex] : historyDraft;
          if (replacement != null) {
            setText(replacement);
          }
          requestAnimationFrame(() => {
            try {
              el.setSelectionRange(0, 0);
            } catch {}
          });
        } else if (e.key === 'ArrowDown' && caretAtEnd && historyIndex > 0) {
          e.preventDefault();
          const nextIndex = Math.max(0, historyIndex - 1);
          setHistoryIndex(nextIndex);
          const replacement = nextIndex > 0 ? history[history.length - nextIndex] : historyDraft;
          if (replacement != null) {
            setText(replacement);
          }
          requestAnimationFrame(() => {
            const pos = (replacement ?? '').length;
            try {
              el.setSelectionRange(pos, pos);
            } catch {}
          });
        }
      }
    },
    [text, history, historyIndex, historyDraft, handleSubmit, insertNewlineAtCursor, thinking, onStop]
  );

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = file.type.split('/')[1] || 'png';
          const named = new File([file], `paste-${Date.now()}.${ext}`, { type: file.type });
          imageFiles.push(named);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      setFiles((prev) => [...prev, ...imageFiles]);
    }
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
  }, []);

  return (
    <div className="chat-input-footer">
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
              {files.map((f, i) =>
                f.type.startsWith('image/') ? (
                  <div key={i} className="relative group">
                    <img
                      src={URL.createObjectURL(f)}
                      alt=""
                      className="h-20 w-20 rounded-lg object-cover border border-border"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => {
                        setFiles((prev) => prev.filter((_, idx) => idx !== i));
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
                      }}
                      className="absolute -top-1.5 -right-1.5 size-5 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                ) : (
                  <div key={i} className="bg-card flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                    <PaperclipIcon className="size-4 text-foreground" />
                    <span className="max-w-30 truncate text-foreground" title={f.name}>
                      {f.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => {
                        setFiles((prev) => prev.filter((_, idx) => idx !== i));
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
                      }}
                      className="rounded-full"
                    >
                      <XIcon className="size-4 text-foreground" />
                    </Button>
                  </div>
                )
              )}
            </div>
          )}

          <PromptInputTextarea
            placeholder="How can I help you today?"
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="max-h-1/2"
            disabled={disabled}
          />

          <PromptInputActions className="flex items-center justify-between gap-1 sm:gap-2 pt-2 px-2">
            <div className="flex items-center gap-1 min-w-0 pr-1">
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
                <PaperclipIcon className="size-4 text-foreground" />
              </label>

              {!!workspacePath && !isSessionScratchPath(workspacePath) && (
                /* Passive indicator of the attached folder. The environment is
                   bound at launch, so there is nothing to click. */
                <span
                  className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs font-normal text-muted-foreground"
                  title={workspacePath}
                >
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="max-w-24 truncate sm:max-w-50">{basename(workspacePath)}</span>
                </span>
              )}

              {sandboxLabel && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!sandboxInteractive}
                      title={
                        sandboxLocked
                          ? `Sandbox: ${sandboxLabel} (locked once a run starts)`
                          : `Sandbox: ${sandboxLabel}`
                      }
                      className="h-7 min-w-0 gap-1.5 px-2 text-xs font-normal"
                    >
                      {sandboxLoading ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                      <MonitorIcon
                        className={`size-3.5 shrink-0 ${sandboxInteractive ? 'text-primary' : 'text-secondary-foreground'}`}
                      />
                      <span className="max-w-24 truncate sm:max-w-50">{sandboxLabel}</span>
                      {sandboxLocked && <LockIcon className="size-2.5 shrink-0 text-muted-foreground" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="min-w-45">
                    <DropdownMenuRadioGroup value={currentSandboxProfile} onValueChange={handleSandboxSelect}>
                      {sandboxOptions?.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value} className="text-xs">
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {composerExtras}
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {localVoiceSupported ? (
                <>
                  <Toggle
                    size="sm"
                    pressed={!!speakRepliesEnabled}
                    onPressedChange={onSpeakRepliesChange}
                    className="rounded-2xl text-muted-foreground data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                    aria-label={speakerToggleLabel}
                    title={speakerToggleLabel}
                  >
                    {speakRepliesEnabled ? <Volume2Icon className="size-4" /> : <VolumeXIcon className="size-4" />}
                  </Toggle>
                  <LocalVoiceButton onSubmit={(t) => (onVoiceSubmit ?? onSubmit)(t)} />
                </>
              ) : hostedVoiceSupported ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setIsVoiceModalOpen(true)}
                  className="rounded-2xl"
                  aria-label="Voice mode"
                >
                  <MicIcon className="size-4 text-foreground" />
                </Button>
              ) : null}

              {!thinking ? (
                <Button
                  type="button"
                  size="icon-sm"
                  disabled={!canSend}
                  onClick={handleSubmit}
                  className="rounded-full"
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <ArrowUpIcon className="pointer-events-none size-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  onClick={onStop}
                  className="rounded-full"
                  aria-label="Stop"
                  title="Stop"
                >
                  <SquareIcon className="pointer-events-none size-4" />
                </Button>
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
          onClose={() => {
            setIsVoiceModalOpen(false);
            onVoiceClose?.();
          }}
        />
      )}
    </div>
  );
}
