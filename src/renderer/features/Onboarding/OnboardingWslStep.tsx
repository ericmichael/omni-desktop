import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ChevronRight20Regular } from '@fluentui/react-icons';
import { motion } from 'framer-motion';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1Strong, Caption1, Spinner } from '@/renderer/ds';
import { localEmitter } from '@/renderer/services/ipc';
import type { WslDistro } from '@/shared/types';

type Props = {
  /** Advance to the next step — chosen Windows, or WSL turned out unavailable. */
  onSkip: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    textAlign: 'left',
    padding: '14px 16px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transitionProperty: 'border-color, background-color, transform, box-shadow',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease-out',
    ':hover': {
      ...shorthands.borderColor(tokens.colorBrandStroke1),
      backgroundColor: tokens.colorSubtleBackgroundHover,
      boxShadow: tokens.shadow4,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '1px',
    },
    ':disabled': { cursor: 'default', opacity: 0.6 },
  },
  optionBody: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
  chevron: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
});

/**
 * Windows-only, skippable: offer running the Omni backend inside WSL before
 * any provider setup, so the config the rest of the wizard writes lands in
 * the backend that will actually be used (choosing WSL relaunches the app
 * against a fresh data root inside the distro — see the Decision 8 note in
 * docs/windows-wsl-backend-plan.md).
 */
export const OnboardingWslStep = memo(({ onSkip }: Props) => {
  const styles = useStyles();
  const [defaultDistro, setDefaultDistro] = useState<WslDistro | null>(null);
  const [linking, setLinking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probe local main for WSL; when it's missing (or the probe fails) skip the
  // step entirely rather than showing a dead-end choice.
  useEffect(() => {
    let cancelled = false;
    void localEmitter
      .invoke('wsl:detect')
      .then((result) => {
        if (cancelled) {
          return;
        }
        const preferred =
          result.wsl === 'ok' ? (result.distros.find((d) => d.isDefault) ?? result.distros[0]) : undefined;
        if (preferred) {
          setDefaultDistro(preferred);
        } else {
          onSkip();
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
    return (
      <div className={styles.root}>
        <div className={styles.pendingRow}>
          <Spinner size="sm" />
          <Caption1>Checking for WSL…</Caption1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Where should the Omni backend run?</Body1Strong>
        <Caption1>You can switch later from Settings.</Caption1>
      </div>

      <div className={styles.list}>
        <motion.button
          type="button"
          className={styles.option}
          onClick={handleUseWsl}
          disabled={linking || restarting}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <span className={styles.optionBody}>
            <Body1Strong>Run the Omni backend in WSL (recommended)</Body1Strong>
            <Caption1>Sandboxes run natively in Linux — uses your {defaultDistro.name} distro</Caption1>
          </span>
          <ChevronRight20Regular className={styles.chevron} />
        </motion.button>

        <motion.button
          type="button"
          className={styles.option}
          onClick={onSkip}
          disabled={linking || restarting}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05, ease: 'easeOut' }}
        >
          <span className={styles.optionBody}>
            <Body1Strong>Run everything on Windows</Body1Strong>
            <Caption1>Keep the backend on this machine — no WSL involved</Caption1>
          </span>
          <ChevronRight20Regular className={styles.chevron} />
        </motion.button>
      </div>

      {linking && (
        <div className={styles.pendingRow}>
          <Spinner size="sm" />
          <Caption1>Setting up the WSL backend in {defaultDistro.name}…</Caption1>
        </div>
      )}

      {restarting && <Caption1 className={styles.ok}>Restarting Omni Code…</Caption1>}

      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
});
OnboardingWslStep.displayName = 'OnboardingWslStep';
