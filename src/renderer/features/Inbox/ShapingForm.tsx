import { memo, useCallback, useState } from 'react';

import { Button, cn, SectionLabel, Textarea } from '@/renderer/ds';
import type { Appetite, ShapingData } from '@/shared/types';

import { APPETITE_DESCRIPTIONS, APPETITE_LABELS } from './shaping-constants';

type ShapingFormProps = {
  initial?: ShapingData;
  onSave: (shaping: ShapingData) => void;
};

const APPETITES: Appetite[] = ['small', 'medium', 'large'];

export const ShapingForm = memo(({ initial, onSave }: ShapingFormProps) => {
  const [doneLooksLike, setDoneLooksLike] = useState(initial?.doneLooksLike ?? '');
  const [appetite, setAppetite] = useState<Appetite>(initial?.appetite ?? 'medium');
  const [outOfScope, setOutOfScope] = useState(initial?.outOfScope ?? '');

  const isValid = doneLooksLike.trim().length > 0 && outOfScope.trim().length > 0;

  const handleSave = useCallback(() => {
    if (!isValid) return;
    onSave({
      doneLooksLike: doneLooksLike.trim(),
      appetite,
      outOfScope: outOfScope.trim(),
    });
  }, [doneLooksLike, appetite, outOfScope, isValid, onSave]);

  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
      <SectionLabel>Shape this work</SectionLabel>

      {/* Done looks like */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-fg-muted">What does done look like?</label>
        <Textarea
          value={doneLooksLike}
          onChange={(e) => setDoneLooksLike(e.target.value)}
          placeholder="When this is finished, what's true that isn't true now?"
          rows={2}
          maxHeight={120}
          className="rounded-xl"
        />
      </div>

      {/* Appetite */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-fg-muted">Appetite</label>
        <div className="flex items-center gap-2">
          {APPETITES.map((a) => (
            <button
              key={a}
              onClick={() => setAppetite(a)}
              className={cn(
                'flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium transition-colors flex-1',
                appetite === a
                  ? 'bg-accent-600/20 text-accent-400 border border-accent-500/30'
                  : 'bg-surface-overlay text-fg-muted hover:text-fg border border-transparent'
              )}
            >
              <span>{APPETITE_LABELS[a]}</span>
              <span className="text-[10px] font-normal opacity-70">{APPETITE_DESCRIPTIONS[a]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Out of scope */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-fg-muted">What's out of scope?</label>
        <Textarea
          value={outOfScope}
          onChange={(e) => setOutOfScope(e.target.value)}
          placeholder="What are we explicitly NOT doing?"
          rows={2}
          maxHeight={120}
          className="rounded-xl"
        />
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} isDisabled={!isValid}>
          Shape
        </Button>
      </div>
    </div>
  );
});
ShapingForm.displayName = 'ShapingForm';
