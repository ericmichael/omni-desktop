import { memo, useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { Input } from './components/Input';
import { getGreeting } from './greeting';
import { OmniAgentsHeaderActionsProvider } from './header-actions';

type ChatShellPhase = 'checking' | 'installing' | 'starting' | 'idle' | 'error';

export type PendingMessage = { text: string; files?: File[] };

type ChatShellProps = {
  greeting?: string;
  phase: ChatShellPhase;
  error?: string | null;
  onRetry?: () => void;
  onLaunch?: () => void;
  launchDisabled?: boolean;
  details?: React.ReactNode;
  onSubmit?: (msg: PendingMessage) => void;
  pendingMessages?: PendingMessage[];
};

const headerActions = {
  showArtifactsButton: false,
  showTerminalButton: false,
  onArtifactsToggle: undefined,
  onTerminalToggle: undefined,
};

export const ChatShell = memo(
  ({ greeting: greetingProp, phase, error, onRetry, onLaunch, launchDisabled, onSubmit, pendingMessages }: ChatShellProps) => {
    const handleSubmit = useCallback(
      (text: string, files?: File[]) => {
        onSubmit?.({ text, files });
      },
      [onSubmit]
    );

    const [fallbackGreeting] = useState(getGreeting);
    const greeting = greetingProp ?? fallbackGreeting;
    const isConnecting = phase === 'checking' || phase === 'installing' || phase === 'starting';
    const hasPending = pendingMessages && pendingMessages.length > 0;

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
                    <div className="flex-1 px-3 py-3">
                      {pendingMessages.map((m, i) => (
                        <motion.div
                          key={i}
                          className="flex justify-end mb-3"
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.3, ease: 'easeOut' }}
                        >
                          <div className="max-w-[80%] rounded-2xl bg-tweetBlue/10 px-4 py-2.5 text-sm text-textHeading">
                            {m.text}
                            {m.files && m.files.length > 0 && (
                              <div className="mt-1 text-xs text-textSubtle">
                                {m.files.length} file{m.files.length > 1 ? 's' : ''} attached
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex-1 relative">
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none [&_button]:pointer-events-auto">
                        <div className="mx-auto max-w-2xl text-center px-4">
                          <div className="text-4xl font-normal tracking-tight text-textHeading font-serif">
                            {greeting}
                          </div>
                          <AnimatePresence>
                            {phase === 'error' && error && (
                              <motion.div
                                className="mt-4 text-sm text-errorRed"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3 }}
                              >
                                {error}
                              </motion.div>
                            )}
                          </AnimatePresence>
                          <AnimatePresence>
                            {phase === 'error' && onRetry && (
                              <motion.div
                                className="mt-4"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3, delay: 0.1 }}
                              >
                                <button
                                  type="button"
                                  onClick={onRetry}
                                  className="h-8 rounded-md bg-tweetBlue px-4 text-sm font-medium text-white hover:brightness-110"
                                >
                                  Retry
                                </button>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          <AnimatePresence>
                            {phase === 'idle' && onLaunch && (
                              <motion.div
                                className="mt-5"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3 }}
                              >
                                <button
                                  type="button"
                                  onClick={onLaunch}
                                  disabled={launchDisabled}
                                  className="h-9 rounded-full bg-tweetBlue px-5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                                >
                                  Launch workspace
                                </button>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>

                      <AnimatePresence>
                        {isConnecting && (
                          <motion.div
                            className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none z-10"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeOut' }}
                          >
                            <div className="inline-flex items-center gap-1.5 rounded-full bg-bgCardAlt px-3 py-1">
                              <svg
                                className="animate-spin h-3 w-3 text-textSubtle"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                              <span className="text-xs text-textSubtle">Connecting…</span>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
                <Input onSubmit={handleSubmit} />
              </div>
            </div>
          </div>
        </div>
      </OmniAgentsHeaderActionsProvider>
    );
  }
);
ChatShell.displayName = 'ChatShell';
