import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { persistedStoreApi } from '@/renderer/services/store';
import { TEXT_SCALES, type TextScale } from '@/renderer/theme/themes';
import type { OmniTheme } from '@/shared/types';

const TEXT_SCALE_LABELS: Record<TextScale, string> = {
  90: 'Small',
  100: 'Default',
  110: 'Large',
  125: 'Extra large',
};

export const SettingsModalAppearanceTab = memo(() => {
  const store = useStore(persistedStoreApi.$atom);

  const onChangeTheme = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('theme', e.target.value as OmniTheme);
  }, []);

  const onChangeTextScale = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('textScale', Number(e.target.value));
  }, []);

  return (
    <SettingsPane>
      <SettingsSection title="Display">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Theme</FieldLabel>
              </div>
              <Select value={store.theme ?? 'omni'} onChange={onChangeTheme}>
                <option value="omni">Omni</option>
                <option value="teams-light">Teams Light</option>
                <option value="teams-dark">Teams Dark</option>
                <option value="default">Shadcn Default</option>
                <option value="tokyo-night">Tokyo Night</option>
                <option value="vscode-dark">VS Code Dark</option>
                <option value="vscode-light">VS Code Light</option>
                <option value="utrgv">UTRGV</option>
              </Select>
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Text size</FieldLabel>
              </div>
              <Select value={String(store.textScale ?? 100)} onChange={onChangeTextScale}>
                {TEXT_SCALES.map((scale) => (
                  <option key={scale} value={String(scale)}>
                    {TEXT_SCALE_LABELS[scale]}
                  </option>
                ))}
              </Select>
            </Field>
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalAppearanceTab.displayName = 'SettingsModalAppearanceTab';
