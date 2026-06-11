import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useRef } from 'react';

import { Button, Card, FormField, SectionLabel, Select } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import { isGlassTheme, TEXT_SCALES, type TextScale } from '@/renderer/theme/fluent-themes';
import { detectGlassTone } from '@/renderer/theme/glass-vars';
import type { OmniTheme } from '@/shared/types';

const TEXT_SCALE_LABELS: Record<TextScale, string> = {
  90: 'Small',
  100: 'Default',
  110: 'Large',
  125: 'Extra large',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  textSimple: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalAppearanceTab = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);

  const onChangeTheme = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('theme', e.target.value as OmniTheme);
  }, []);

  const onChangeTextScale = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('textScale', Number(e.target.value));
  }, []);

  const deckBgInputRef = useRef<HTMLInputElement>(null);
  const pickDeckBackground = useCallback(() => {
    deckBgInputRef.current?.click();
  }, []);
  const clearDeckBackground = useCallback(() => {
    persistedStoreApi.setKey('codeDeckBackground', null);
  }, []);
  const onDeckBackgroundFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      window.alert('Please choose an image file.');
      return;
    }
    const MAX = 3 * 1024 * 1024;
    if (file.size > MAX) {
      window.alert(`Image is too large (max ${Math.round(MAX / 1024 / 1024)}MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        return;
      }
      // Pick a glass tone from wallpaper luminance so the frosted material stays
      // readable: dark photo → black scrim + light text; bright photo → white
      // scrim + dark text. Independent of the active theme.
      const tone = await detectGlassTone(result);
      persistedStoreApi.setKey('codeDeckBackground', result);
      persistedStoreApi.setKey('glassTone', tone);
    };
    reader.readAsDataURL(file);
  }, []);

  return (
    <div className={styles.root}>
      <SectionLabel>Display</SectionLabel>
      <Card>
        <FormField label="Theme">
          <Select value={store.theme ?? 'omni'} onChange={onChangeTheme}>
            <option value="omni">Omni (Glass)</option>
            <option value="teams-light">Teams Light</option>
            <option value="teams-dark">Teams Dark</option>
            <option value="default">Indigo Dark</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="vscode-dark">VS Code Dark</option>
            <option value="vscode-light">VS Code Light</option>
            <option value="utrgv">UTRGV</option>
          </Select>
        </FormField>
        <FormField label="Text size">
          <Select value={String(store.textScale ?? 100)} onChange={onChangeTextScale}>
            {TEXT_SCALES.map((scale) => (
              <option key={scale} value={String(scale)}>
                {TEXT_SCALE_LABELS[scale]}
              </option>
            ))}
          </Select>
        </FormField>
        {/* The Background only exists on glass themes: it's the backdrop the
            translucent surfaces sit over. Flat themes have no backdrop. */}
        {isGlassTheme(store.theme ?? 'omni') && (
          <FormField label="Background">
            <span className={styles.textSimple}>{store.codeDeckBackground ? 'Custom image' : 'Built-in'}</span>
            <input
              ref={deckBgInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={onDeckBackgroundFile}
            />
            <Button size="sm" variant="ghost" onClick={pickDeckBackground}>
              {store.codeDeckBackground ? 'Change' : 'Upload image'}
            </Button>
            {store.codeDeckBackground && (
              <Button size="sm" variant="ghost" onClick={clearDeckBackground}>
                Use built-in
              </Button>
            )}
          </FormField>
        )}
      </Card>
    </div>
  );
});
SettingsModalAppearanceTab.displayName = 'SettingsModalAppearanceTab';
