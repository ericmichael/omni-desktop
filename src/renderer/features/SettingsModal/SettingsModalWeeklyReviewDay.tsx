import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { DAY_OPTIONS } from '@/lib/weekly-review';
import { SectionLabel, Select } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  select: { width: '144px' },
});

export const SettingsModalWeeklyReviewDay = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const reviewDay = store.weeklyReviewDay ?? 5;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('weeklyReviewDay', Number(e.target.value));
  }, []);

  return (
    <div className={styles.root}>
      <SectionLabel>Weekly Review</SectionLabel>
      <p className={styles.hint}>
        Pick the day you want to be prompted for a weekly review. The review helps you reflect on
        completed work, triage your inbox, and set intentions.
      </p>
      <Select value={String(reviewDay)} onChange={handleChange} className={styles.select}>
        {DAY_OPTIONS.map((opt) => (
          <option key={opt.value} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );
});
SettingsModalWeeklyReviewDay.displayName = 'SettingsModalWeeklyReviewDay';
