import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { memo, useCallback } from 'react';

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
  {
    value: 'local',
    label: 'On this computer',
    description: 'Ollama and other local models — private, no account needed',
  },
  { value: 'advanced', label: 'Something else', description: 'Azure, LiteLLM, or any custom setup' },
];

type Props = {
  /** Hide the local option where there is no local machine (hosted/server mode). */
  showLocal: boolean;
  onSelect: (kind: IdentityKind) => void;
};

export const OnboardingChooseStep = memo(({ showLocal, onSelect }: Props) => {
  const options = showLocal ? OPTIONS : OPTIONS.filter((o) => o.value !== 'local');

  const handleSelect = useCallback((kind: IdentityKind) => () => onSelect(kind), [onSelect]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Which AI do you use?</span>
        <span className="text-xs text-muted-foreground">
          Omni works with the account you already have. Your keys stay on this machine.
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {options.map((option, index) => (
          <motion.button
            key={option.value}
            type="button"
            className="flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl border border-border bg-background cursor-pointer transition-all duration-150 ease-out hover:border-primary hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:outline-offset-1"
            onClick={handleSelect(option.value)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: index * 0.05, ease: 'easeOut' }}
          >
            <span className="flex flex-col gap-0.5 flex-auto min-w-0">
              <span className="text-sm font-semibold">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </span>
            <ChevronRight className="text-muted-foreground shrink-0" />
          </motion.button>
        ))}
      </div>
    </div>
  );
});
OnboardingChooseStep.displayName = 'OnboardingChooseStep';
