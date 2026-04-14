import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { SectionLabel, Select } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  select: { width: '96px' },
});

export const SettingsModalWipLimit = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const wipLimit = store.wipLimit ?? 3;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('wipLimit', Number(e.target.value));
  }, []);

  return (
    <div className={styles.root}>
      <SectionLabel>WIP Limit</SectionLabel>
      <p className={styles.hint}>
        Maximum active tickets across all projects. Keeps you focused by forcing a choice
        when you try to start more.
      </p>
      <Select value={String(wipLimit)} onChange={handleChange} className={styles.select}>
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
