import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { localEmitter } from '@/renderer/services/ipc';
import type { WslDistro } from '@/shared/types';

type Props = {
  /** Advance to the next step — chosen Windows, or WSL turned out unavailable. */
  onSkip: () => void;
};

/**
 * Windows-only, skippable: offer running the Omni backend inside WSL before
 * any provider setup, so the config the rest of the wizard writes lands in
 * the backend that will actually be used (choosing WSL relaunches the app
 * against a fresh data root inside the distro — see the Decision 8 note in
 * docs/windows-wsl-backend-plan.md).
 */
export const OnboardingWslStep = memo(({ onSkip }: Props) => {
  const [defaultDistro, setDefaultDistro] = useState<WslDistro | null>(null);
  // WSL is present but has zero distros — offer registering Ubuntu inline
  // (`wsl:install` needs no elevation once the platform exists).
  const [needsDistro, setNeedsDistro] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [linking, setLinking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probe local main for WSL. Missing WSL (or a failed probe) skips the step
  // entirely — installing the platform needs elevation + a reboot, a flow
  // that belongs in the settings card, not onboarding.
  useEffect(() => {
    let cancelled = false;
    void localEmitter
      .invoke('wsl:detect')
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.wsl !== 'ok') {
          onSkip();
          return;
        }
        const preferred = result.distros.find((d) => d.isDefault) ?? result.distros[0];
        if (preferred) {
          setDefaultDistro(preferred);
        } else {
          setNeedsDistro(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          onSkip();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onSkip]);

  const handleInstallUbuntu = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      // Registers Ubuntu (the WSL default) from the Store — can take minutes.
      await localEmitter.invoke('wsl:install', 'distro');
      // Re-detect and fall into the normal WSL-vs-Windows choice.
      const result = await localEmitter.invoke('wsl:detect');
      const preferred =
        result.wsl === 'ok' ? (result.distros.find((d) => d.isDefault) ?? result.distros[0]) : undefined;
      if (preferred) {
        setDefaultDistro(preferred);
        setNeedsDistro(false);
      } else {
        setError('Ubuntu did not show up after the install — you can retry from Settings later');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to install Ubuntu');
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleUseWsl = useCallback(async () => {
    if (!defaultDistro) {
      return;
    }
    setLinking(true);
    setError(null);
    try {
      // Resolves in LOCAL main; on success main relaunches the app on the WSL
      // transport, so all we do afterwards is show the restart affordance.
      await localEmitter.invoke('wsl:link', defaultDistro.name);
      setRestarting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set up the WSL backend');
    } finally {
      setLinking(false);
    }
  }, [defaultDistro]);

  if (!defaultDistro) {
    if (!needsDistro) {
      return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-xs text-muted-foreground">Checking for WSL…</span>
          </div>
        </div>
      );
    }
    // Zero-distro machine: same two-way choice, but the WSL path first
    // registers Ubuntu; success re-detects and lands in the normal choice.
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Where should the Omni backend run?</span>
          <span className="text-xs text-muted-foreground">You can switch later from Settings.</span>
        </div>

        <div className="flex flex-col gap-2">
          <motion.button
            type="button"
            className="flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl border border-border bg-background cursor-pointer transition-all duration-150 ease-out hover:border-primary hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60"
            onClick={handleInstallUbuntu}
            disabled={installing}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <span className="flex flex-col gap-0.5 flex-auto min-w-0">
              <span className="text-sm font-semibold">Install Ubuntu in WSL (recommended)</span>
              <span className="text-xs text-muted-foreground">
                WSL 2 is installed but has no Linux distribution — Ubuntu runs sandboxes natively
              </span>
            </span>
            <ChevronRight className="text-muted-foreground shrink-0" />
          </motion.button>

          <motion.button
            type="button"
            className="flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl border border-border bg-background cursor-pointer transition-all duration-150 ease-out hover:border-primary hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60"
            onClick={onSkip}
            disabled={installing}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.05, ease: 'easeOut' }}
          >
            <span className="flex flex-col gap-0.5 flex-auto min-w-0">
              <span className="text-sm font-semibold">Run everything on Windows</span>
              <span className="text-xs text-muted-foreground">Keep the backend on this machine — no WSL involved</span>
            </span>
            <ChevronRight className="text-muted-foreground shrink-0" />
          </motion.button>
        </div>

        {installing && (
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-xs text-muted-foreground">Installing Ubuntu — this downloads a few hundred MB…</span>
          </div>
        )}

        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Where should the Omni backend run?</span>
        <span className="text-xs text-muted-foreground">You can switch later from Settings.</span>
      </div>

      <div className="flex flex-col gap-2">
        <motion.button
          type="button"
          className="flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl border border-border bg-background cursor-pointer transition-all duration-150 ease-out hover:border-primary hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60"
          onClick={handleUseWsl}
          disabled={linking || restarting}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <span className="flex flex-col gap-0.5 flex-auto min-w-0">
            <span className="text-sm font-semibold">Run the Omni backend in WSL (recommended)</span>
            <span className="text-xs text-muted-foreground">
              Sandboxes run natively in Linux — uses your {defaultDistro.name} distro
            </span>
          </span>
          <ChevronRight className="text-muted-foreground shrink-0" />
        </motion.button>

        <motion.button
          type="button"
          className="flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl border border-border bg-background cursor-pointer transition-all duration-150 ease-out hover:border-primary hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60"
          onClick={onSkip}
          disabled={linking || restarting}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05, ease: 'easeOut' }}
        >
          <span className="flex flex-col gap-0.5 flex-auto min-w-0">
            <span className="text-sm font-semibold">Run everything on Windows</span>
            <span className="text-xs text-muted-foreground">Keep the backend on this machine — no WSL involved</span>
          </span>
          <ChevronRight className="text-muted-foreground shrink-0" />
        </motion.button>
      </div>

      {linking && (
        <div className="flex items-center gap-2">
          <Spinner />
          <span className="text-xs text-muted-foreground">Setting up the WSL backend in {defaultDistro.name}…</span>
        </div>
      )}

      {restarting && <span className={cn('text-xs text-muted-foreground', 'text-success')}>Restarting Omni Code…</span>}

      {error && <span className="text-destructive text-xs">{error}</span>}
    </div>
  );
});
OnboardingWslStep.displayName = 'OnboardingWslStep';
