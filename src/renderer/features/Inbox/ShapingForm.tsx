import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { memo, useCallback, useState } from 'react';

import { Button, Radio, RadioGroup, SectionLabel, Textarea } from '@/renderer/ds';
import type { Appetite, ShapingData } from '@/shared/types';

import { APPETITE_DESCRIPTIONS, APPETITE_LABELS } from './shaping-constants';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    borderRadius: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalL,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightMedium, color: tokens.colorNeutralForeground2 },
  footer: { display: 'flex', justifyContent: 'flex-end' },
});

type ShapingFormProps = {
  initial?: ShapingData;
  onSave: (shaping: ShapingData) => void;
};

const APPETITES: Appetite[] = ['small', 'medium', 'large'];

export const ShapingForm = memo(({ initial, onSave }: ShapingFormProps) => {
  const styles = useStyles();
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
    <div className={styles.root}>
      <SectionLabel>Shape this work</SectionLabel>

      {/* Done looks like */}
      <div className={styles.field}>
        <label className={styles.label}>What does done look like?</label>
        <Textarea
          value={doneLooksLike}
          onChange={(e) => setDoneLooksLike(e.target.value)}
          placeholder="When this is finished, what's true that isn't true now?"
          rows={2}
          maxHeight={120}
        />
      </div>

      {/* Appetite */}
      <div className={styles.field}>
        <label className={styles.label}>Appetite</label>
        <RadioGroup
          layout="horizontal"
          value={appetite}
          onChange={(_e, data) => setAppetite(data.value as Appetite)}
        >
          {APPETITES.map((a) => (
            <Radio
              key={a}
              value={a}
              label={`${APPETITE_LABELS[a]} — ${APPETITE_DESCRIPTIONS[a]}`}
            />
          ))}
        </RadioGroup>
      </div>

      {/* Out of scope */}
      <div className={styles.field}>
        <label className={styles.label}>What's out of scope?</label>
        <Textarea
          value={outOfScope}
          onChange={(e) => setOutOfScope(e.target.value)}
          placeholder="What are we explicitly NOT doing?"
          rows={2}
          maxHeight={120}
        />
      </div>

      <div className={styles.footer}>
        <Button size="sm" onClick={handleSave} isDisabled={!isValid}>
          Shape
        </Button>
      </div>
    </div>
  );
});
ShapingForm.displayName = 'ShapingForm';
