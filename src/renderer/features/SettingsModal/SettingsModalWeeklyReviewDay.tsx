import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { SectionLabel, Select } from '@/renderer/ds';
import { DAY_OPTIONS } from '@/lib/weekly-review';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalWeeklyReviewDay = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const reviewDay = store.weeklyReviewDay ?? 5;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('weeklyReviewDay', Number(e.target.value));
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Weekly Review</SectionLabel>
      <p className="text-xs text-fg-muted">
        Pick the day you want to be prompted for a weekly review. The review helps you reflect on
        completed work, triage your inbox, and set intentions.
      </p>
      <Select value={String(reviewDay)} onChange={handleChange} className="w-36">
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
