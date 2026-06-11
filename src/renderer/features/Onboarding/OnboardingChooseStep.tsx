import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ChevronRight20Regular } from '@fluentui/react-icons';
import { motion } from 'framer-motion';
import { memo, useCallback } from 'react';

import { Body1Strong, Caption1 } from '@/renderer/ds';

/** User-facing identity, not runtime provider type — the wizard maps it later. */
export type IdentityKind = 'chatgpt' | 'openai' | 'anthropic' | 'local' | 'advanced';

type IdentityOption = {
  value: IdentityKind;
  label: string;
  description: string;
};

const OPTIONS: IdentityOption[] = [
  { value: 'chatgpt', label: 'ChatGPT', description: 'Sign in with your ChatGPT account — Plus, Pro, or Team' },
  { value: 'openai', label: 'OpenAI', description: 'Connect with an API key from platform.openai.com' },
  { value: 'anthropic', label: 'Claude', description: 'Connect with an API key from console.anthropic.com' },
  { value: 'local', label: 'On this computer', description: 'Ollama and other local models — private, no account needed' },
  { value: 'advanced', label: 'Something else', description: 'Azure, LiteLLM, or any custom setup' },
];

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
  },
  optionBody: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
  chevron: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

type Props = {
  /** Hide the local option where there is no local machine (hosted/server mode). */
  showLocal: boolean;
  onSelect: (kind: IdentityKind) => void;
};

export const OnboardingChooseStep = memo(({ showLocal, onSelect }: Props) => {
  const styles = useStyles();
  const options = showLocal ? OPTIONS : OPTIONS.filter((o) => o.value !== 'local');

  const handleSelect = useCallback((kind: IdentityKind) => () => onSelect(kind), [onSelect]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Which AI do you use?</Body1Strong>
        <Caption1>Omni works with the account you already have. Your keys stay on this machine.</Caption1>
      </div>

      <div className={styles.list}>
        {options.map((option, index) => (
          <motion.button
            key={option.value}
            type="button"
            className={styles.option}
            onClick={handleSelect(option.value)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: index * 0.05, ease: 'easeOut' }}
          >
            <span className={styles.optionBody}>
              <Body1Strong>{option.label}</Body1Strong>
              <Caption1>{option.description}</Caption1>
            </span>
            <ChevronRight20Regular className={styles.chevron} />
          </motion.button>
        ))}
      </div>
    </div>
  );
});
OnboardingChooseStep.displayName = 'OnboardingChooseStep';
