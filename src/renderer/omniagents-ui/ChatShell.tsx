import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { memo, useCallback, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { Spinner } from '@/renderer/ds/ui/spinner';

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
  onSubmit: (msg: PendingMessage) => void;
  pendingMessages?: PendingMessage[];
  suggestions?: ReadonlyArray<ChatShellSuggestion>;
  sandboxLabel?: string;
  /** Sandbox choices for the composer chip — same control, same place as the
   *  live session, so the composer looks identical pre- and post-launch. */
  sandboxOptions?: { value: string; label: string }[];
  currentSandboxProfile?: string;
  onSandboxChange?: (value: string) => void;
  /** Extra composer chips (e.g. attach-project), mirrored into the live app. */
  composerExtras?: ReactNode;
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
    onSubmit,
    pendingMessages,
    suggestions,
    sandboxLabel = 'sandbox',
    sandboxOptions,
    currentSandboxProfile,
    onSandboxChange,
    composerExtras,
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
        <Alert variant="destructive" className="text-left">
          <AlertTitle>Couldn’t start {sandboxLabel}</AlertTitle>
          {error && <AlertDescription>{error}</AlertDescription>}
          {onRetry && (
            <Button type="button" onClick={onRetry} className="col-start-2 mt-2 justify-self-start rounded-full">
              Retry
            </Button>
          )}
        </Alert>
      ) : isConnecting ? (
        <Badge variant="secondary" role="status" aria-live="polite" className="gap-2 px-3 py-1.5 font-normal">
          <Spinner className="size-3" aria-hidden="true" />
          Starting {sandboxLabel}…
        </Badge>
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
                          <div className="max-w-4/5 rounded-2xl bg-primary/10 px-4 py-2.5 text-sm text-foreground">
                            {m.text}
                            {m.files && m.files.length > 0 && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {m.files.length} file{m.files.length > 1 ? 's' : ''} attached
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                      {launchStatus && <div className="ml-auto max-w-4/5 text-right">{launchStatus}</div>}
                    </div>
                  ) : (
                    <div className="flex-1 relative">
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none [&_button]:pointer-events-auto">
                        <div className="mx-auto max-w-full sm:max-w-2xl text-center px-6">
                          <div className="text-2xl sm:text-4xl font-normal tracking-tight text-foreground font-serif">
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
                                      <p className="text-sm text-muted-foreground">
                                        Your first message starts a session in {sandboxLabel}.
                                      </p>
                                    )}
                                    {onLaunch && (
                                      <Button
                                        type="button"
                                        onClick={onLaunch}
                                        disabled={launchDisabled}
                                        className="rounded-full px-5"
                                      >
                                        Launch workspace
                                      </Button>
                                    )}
                                    {!!suggestions?.length && (
                                      <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-center">
                                        {suggestions.map((suggestion) => (
                                          <Button
                                            key={suggestion.label}
                                            type="button"
                                            variant="outline"
                                            onClick={() => onSubmit({ text: suggestion.prompt })}
                                            className="rounded-full px-4"
                                          >
                                            {suggestion.label}
                                          </Button>
                                        ))}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <Card className="gap-3 py-4 text-left shadow-none">
                                    <CardHeader className="gap-1 px-5">
                                      <CardTitle className="text-base">
                                        Choose a workspace folder to start chatting
                                      </CardTitle>
                                    </CardHeader>
                                    <CardContent className="px-5">
                                      <p className="text-sm text-muted-foreground">
                                        Omni uses it to create an isolated workspace for each session.
                                      </p>
                                      <Button
                                        type="button"
                                        onClick={onOpenWorkspaceSettings}
                                        disabled={!onOpenWorkspaceSettings}
                                        className="mt-4 rounded-full"
                                      >
                                        Open workspace settings
                                      </Button>
                                    </CardContent>
                                  </Card>
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
                <Input
                  onSubmit={handleSubmit}
                  disabled={!workspaceReady}
                  sandboxLabel={sandboxLabel}
                  sandboxOptions={sandboxOptions}
                  currentSandboxProfile={currentSandboxProfile}
                  onSandboxChange={onSandboxChange}
                  composerExtras={composerExtras}
                />
              </div>
            </div>
          </div>
        </div>
      </OmniAgentsHeaderActionsProvider>
    );
  }
);
ChatShell.displayName = 'ChatShell';
