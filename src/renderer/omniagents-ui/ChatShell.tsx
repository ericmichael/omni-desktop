import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { memo, useCallback, useState } from 'react';

import { Input } from './components/Input';
import { getGreeting } from './greeting';
import { OmniAgentsHeaderActionsProvider } from './header-actions';

type ChatShellPhase = 'loading' | 'idle' | 'error';

export type PendingMessage = { text: string; files?: File[] };
export type ChatShellSuggestion = { label: string; prompt: string };

type ChatShellProps = {
  greeting?: string;
  phase: ChatShellPhase;
  error?: string | null;
  onRetry?: () => void;
  onLaunch?: () => void;
  launchDisabled?: boolean;
  prelaunchExtras?: ReactNode;
  onSubmit: (msg: PendingMessage) => void;
  pendingMessages?: PendingMessage[];
  suggestions?: ReadonlyArray<ChatShellSuggestion>;
  sandboxLabel?: string;
  workspaceReady?: boolean;
  onOpenWorkspaceSettings?: () => void;
};

const headerActions = {
  showArtifactsButton: false,
  onArtifactsToggle: undefined,
};

export const ChatShell = memo(
  ({
    greeting: greetingProp,
    phase,
    error,
    onRetry,
    onLaunch,
    launchDisabled,
    prelaunchExtras,
    onSubmit,
    pendingMessages,
    suggestions,
    sandboxLabel = 'sandbox',
    workspaceReady = true,
    onOpenWorkspaceSettings,
  }: ChatShellProps) => {
    const handleSubmit = useCallback(
      (text: string, files?: File[]) => {
        onSubmit({ text, files });
      },
      [onSubmit]
    );

    const [fallbackGreeting] = useState(getGreeting);
    const greeting = greetingProp ?? fallbackGreeting;
    const isConnecting = phase === 'loading';
    const hasPending = !!pendingMessages?.length;

    const launchStatus =
      phase === 'error' ? (
        <div role="alert" className="rounded-xl border border-errorRed/30 bg-errorRed/5 px-4 py-3 text-left">
          <div className="text-sm font-medium text-textHeading">Couldn’t start {sandboxLabel}</div>
          {error && <div className="mt-1 text-sm text-errorRed">{error}</div>}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Retry
            </button>
          )}
        </div>
      ) : isConnecting ? (
        <div
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full bg-bgCardAlt px-3 py-1.5 text-xs text-textSubtle"
        >
          <svg
            className="h-3 w-3 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Starting {sandboxLabel}…
        </div>
      ) : null;

    return (
      <OmniAgentsHeaderActionsProvider {...headerActions}>
        <div className="app h-full flex flex-row min-w-0 relative">
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            {/* Spacer matching the App header height so greeting centers identically */}
            <div className="h-10 shrink-0" />
            <div className="flex-1 flex flex-row min-h-0 min-w-0">
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                <div className="flex-1 min-h-0 relative flex flex-col">
                  {hasPending ? (
                    <div className="flex-1 overflow-y-auto px-3 py-3">
                      {pendingMessages.map((m, i) => (
                        <motion.div
                          key={i}
                          className="flex justify-end mb-3"
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.3, ease: 'easeOut' }}
                        >
                          <div className="max-w-[80%] rounded-2xl bg-primary/10 px-4 py-2.5 text-sm text-textHeading">
                            {m.text}
                            {m.files && m.files.length > 0 && (
                              <div className="mt-1 text-xs text-textSubtle">
                                {m.files.length} file{m.files.length > 1 ? 's' : ''} attached
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                      {launchStatus && <div className="ml-auto max-w-[80%] text-right">{launchStatus}</div>}
                    </div>
                  ) : (
                    <div className="flex-1 relative">
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none [&_button]:pointer-events-auto">
                        <div className="mx-auto max-w-full sm:max-w-2xl text-center px-6">
                          <div className="text-2xl sm:text-4xl font-normal tracking-tight text-textHeading font-serif">
                            {greeting}
                          </div>
                          <AnimatePresence>
                            {phase === 'idle' && (
                              <motion.div
                                className="mt-5"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3 }}
                              >
                                {workspaceReady ? (
                                  <>
                                    {!onLaunch && (
                                      <p className="text-sm text-textSubtle">
                                        Your first message starts a session in {sandboxLabel}.
                                      </p>
                                    )}
                                    {onLaunch && (
                                      <button
                                        type="button"
                                        onClick={onLaunch}
                                        disabled={launchDisabled}
                                        className="min-h-9 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50"
                                      >
                                        Launch workspace
                                      </button>
                                    )}
                                    {!!suggestions?.length && (
                                      <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-center">
                                        {suggestions.map((suggestion) => (
                                          <button
                                            key={suggestion.label}
                                            type="button"
                                            onClick={() => onSubmit({ text: suggestion.prompt })}
                                            className="min-h-9 rounded-full border border-border bg-bgCard px-4 py-2 text-sm font-medium text-textHeading hover:bg-bgCardAlt focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                                          >
                                            {suggestion.label}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <section
                                    aria-labelledby="workspace-setup-heading"
                                    className="rounded-2xl border border-border bg-bgCard px-5 py-4"
                                  >
                                    <h2
                                      id="workspace-setup-heading"
                                      className="text-base font-semibold text-textHeading"
                                    >
                                      Choose a workspace folder to start chatting
                                    </h2>
                                    <p className="mt-1 text-sm text-textSubtle">
                                      Omni uses it to create an isolated workspace for each session.
                                    </p>
                                    <button
                                      type="button"
                                      onClick={onOpenWorkspaceSettings}
                                      disabled={!onOpenWorkspaceSettings}
                                      className="mt-4 min-h-9 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                                    >
                                      Open workspace settings
                                    </button>
                                  </section>
                                )}
                                {prelaunchExtras && (
                                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                                    {prelaunchExtras}
                                  </div>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                          {phase !== 'idle' && launchStatus && (
                            <div className="mt-5 flex justify-center">{launchStatus}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <Input onSubmit={handleSubmit} disabled={!workspaceReady} />
              </div>
            </div>
          </div>
        </div>
      </OmniAgentsHeaderActionsProvider>
    );
  }
);
ChatShell.displayName = 'ChatShell';
