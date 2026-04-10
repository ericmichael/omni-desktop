import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { SectionLabel, Select } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalWipLimit = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const wipLimit = store.wipLimit ?? 3;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('wipLimit', Number(e.target.value));
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>WIP Limit</SectionLabel>
      <p className="text-xs text-fg-muted">
        Maximum active tickets across all projects. Keeps you focused by forcing a choice
        when you try to start more.
      </p>
      <Select value={String(wipLimit)} onChange={handleChange} className="w-24">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </Select>
    </div>
  );
});
SettingsModalWipLimit.displayName = 'SettingsModalWipLimit';
