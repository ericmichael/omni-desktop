import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { Input } from '@/renderer/ds/ui/input';
import { RadioGroup, RadioGroupItem } from '@/renderer/ds/ui/radio-group';
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

export const OnboardingModelPickStep = memo(({ choices, liveModels, onContinue, onBack }: Props) => {
  const recommended = choices.find((c) => c.recommended) ?? choices[0];
  const [selected, setSelected] = useState<string>(recommended?.id ?? CUSTOM_VALUE);
  const [showMore, setShowMore] = useState(false);
  const [customId, setCustomId] = useState('');

  const extraLive = useMemo(() => {
    const curated = new Set(choices.map((c) => c.id));
    return liveModels.filter((id) => !curated.has(id));
  }, [choices, liveModels]);

  const handleChange = useCallback((value: string) => setSelected(value), []);
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
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Pick a model</span>
        <span className="text-xs text-muted-foreground">
          You can switch models any time — this is just the starting default.
        </span>
      </div>

      <Collapsible open={showMore} onOpenChange={setShowMore}>
        <RadioGroup value={selected} onValueChange={handleChange}>
          {choices.map((choice) => (
            <label key={choice.id} className="inline-flex items-center gap-2 text-sm">
              <RadioGroupItem value={choice.id} />
              <div>
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{choice.label}</span>
                  {choice.recommended && <Badge variant="secondary">Recommended</Badge>}
                </span>
                {choice.blurb && <span className="text-xs text-muted-foreground block">{choice.blurb}</span>}
              </div>
            </label>
          ))}

          <CollapsibleContent>
            {extraLive.map((id) => (
              <label key={id} className="inline-flex items-center gap-2 text-sm">
                <RadioGroupItem value={id} />
                <span className="text-xs text-muted-foreground">{id}</span>
              </label>
            ))}
            <label className="inline-flex items-center gap-2 text-sm">
              <RadioGroupItem value={CUSTOM_VALUE} />
              <span className="text-xs text-muted-foreground">Enter a model ID…</span>
            </label>
          </CollapsibleContent>
        </RadioGroup>

        <CollapsibleContent>
          {selected === CUSTOM_VALUE && (
            <div className="flex flex-col gap-1.5 pl-7">
              <Input value={customId} onChange={handleCustomChange} placeholder="model-id" autoFocus />
            </div>
          )}
        </CollapsibleContent>

        {!showMore && (
          <div className="flex flex-col gap-2">
            <div>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  More models
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        )}
      </Collapsible>

      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="default" size="sm" onClick={handleContinue} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
});
OnboardingModelPickStep.displayName = 'OnboardingModelPickStep';
