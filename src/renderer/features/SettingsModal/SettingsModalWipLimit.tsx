import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Field, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalWipLimit = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const wipLimit = store.wipLimit ?? 3;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('wipLimit', Number(e.target.value));
  }, []);

  return (
    <Field orientation="horizontal" className="justify-between gap-4">
      <div className="min-w-0">
        <FieldLabel>Concurrent tasks</FieldLabel>
        <FieldDescription>
          Maximum tasks Autopilot runs at once across all projects. Starting work yourself is never blocked.
        </FieldDescription>
      </div>
      <Select value={String(wipLimit)} onChange={handleChange} className="w-24">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </Select>
    </Field>
  );
});
SettingsModalWipLimit.displayName = 'SettingsModalWipLimit';
