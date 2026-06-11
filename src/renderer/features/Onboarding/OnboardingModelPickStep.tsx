import { makeStyles } from '@fluentui/react-components';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import { Badge, Body1Strong, Button, Caption1, Input, Radio, RadioGroup } from '@/renderer/ds';
import type { ModelChoice } from '@/shared/model-catalog';
import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@/shared/model-catalog';

export type PickedModel = { id: string; label: string; maxInput: number; maxOutput: number };

type Props = {
  choices: ModelChoice[];
  /** Full live listing — ids beyond the curated set live under "More models". */
  liveModels: string[];
  onContinue: (model: PickedModel) => void;
  onBack: () => void;
};

const CUSTOM_VALUE = '__custom__';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  choiceLabel: { display: 'flex', alignItems: 'center', gap: '8px' },
  more: { display: 'flex', flexDirection: 'column', gap: '8px' },
  customField: { display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '28px' },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingModelPickStep = memo(({ choices, liveModels, onContinue, onBack }: Props) => {
  const styles = useStyles();
  const recommended = choices.find((c) => c.recommended) ?? choices[0];
  const [selected, setSelected] = useState<string>(recommended?.id ?? CUSTOM_VALUE);
  const [showMore, setShowMore] = useState(false);
  const [customId, setCustomId] = useState('');

  const extraLive = useMemo(() => {
    const curated = new Set(choices.map((c) => c.id));
    return liveModels.filter((id) => !curated.has(id));
  }, [choices, liveModels]);

  const handleChange = useCallback((_e: unknown, data: { value: string }) => setSelected(data.value), []);
  const handleShowMore = useCallback(() => setShowMore(true), []);
  const handleCustomChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setCustomId(e.target.value), []);

  const handleContinue = useCallback(() => {
    if (selected === CUSTOM_VALUE) {
      const id = customId.trim();
      if (!id) {
        return;
      }
      onContinue({ id, label: id, maxInput: DEFAULT_MAX_INPUT_TOKENS, maxOutput: DEFAULT_MAX_OUTPUT_TOKENS });
      return;
    }
    const choice = choices.find((c) => c.id === selected);
    if (choice) {
      onContinue({ id: choice.id, label: choice.label, maxInput: choice.maxInput, maxOutput: choice.maxOutput });
      return;
    }
    // A live id from the "More models" list.
    onContinue({
      id: selected,
      label: selected,
      maxInput: DEFAULT_MAX_INPUT_TOKENS,
      maxOutput: DEFAULT_MAX_OUTPUT_TOKENS,
    });
  }, [selected, customId, choices, onContinue]);

  const canContinue = selected === CUSTOM_VALUE ? customId.trim().length > 0 : selected.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Pick a model</Body1Strong>
        <Caption1>You can switch models any time — this is just the starting default.</Caption1>
      </div>

      <RadioGroup value={selected} onChange={handleChange}>
        {choices.map((choice) => (
          <Radio
            key={choice.id}
            value={choice.id}
            label={
              <div>
                <span className={styles.choiceLabel}>
                  <Body1Strong>{choice.label}</Body1Strong>
                  {choice.recommended && <Badge color="purple">Recommended</Badge>}
                </span>
                {choice.blurb && <Caption1 block>{choice.blurb}</Caption1>}
              </div>
            }
          />
        ))}

        {showMore && (
          <>
            {extraLive.map((id) => (
              <Radio key={id} value={id} label={<Caption1>{id}</Caption1>} />
            ))}
            <Radio value={CUSTOM_VALUE} label={<Caption1>Enter a model ID…</Caption1>} />
          </>
        )}
      </RadioGroup>

      {showMore && selected === CUSTOM_VALUE && (
        <div className={styles.customField}>
          <Input size="sm" mono value={customId} onChange={handleCustomChange} placeholder="model-id" autoFocus />
        </div>
      )}

      {!showMore && (
        <div className={styles.more}>
          <div>
            <Button variant="ghost" size="sm" onClick={handleShowMore}>
              More models
            </Button>
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" size="sm" onClick={handleContinue} isDisabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
});
OnboardingModelPickStep.displayName = 'OnboardingModelPickStep';
