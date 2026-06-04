/**
 * Hotkeys settings. Currently one binding: a global hotkey that toggles voice
 * recording on the hovered code-deck column or the active chat. The recorder
 * captures a key combo and stores it in react-hotkeys-hook format (e.g. `alt+v`).
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';

import { Body1Strong, Button, Caption1, Card, SectionLabel } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  description: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM },
  label: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  controls: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  combo: {
    fontFamily: tokens.fontFamilyMonospace,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    minWidth: '88px',
    textAlign: 'center',
  },
});

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/**
 * Keys that produce/affect text or move the caret. Bound bare, these would fire
 * while the user is typing (the hotkey is active in form fields), so they need a
 * modifier. Everything else — function keys, media keys, Insert/Home/End/Pause,
 * and other dedicated keys — can be bound on their own.
 */
const NAMED_TYPING_KEYS = new Set(['enter', 'tab', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right']);

/** A KeyboardEvent → react-hotkeys-hook combo, or null if not a valid binding. */
function eventToCombo(e: KeyboardEvent): string | null {
  const raw = e.key;
  if (raw === 'Control' || raw === 'Alt' || raw === 'Shift' || raw === 'Meta') {
    return null;
  }
  if (raw === 'Escape') {
    return null; // reserved — cancels recording, and cancels an active capture
  }
  let key = raw;
  if (key === ' ') {
    key = 'space';
  } else if (key.startsWith('Arrow')) {
    key = key.slice(5).toLowerCase();
  } else {
    key = key.toLowerCase();
  }
  // A bare key is allowed unless it's a typing/navigation key. Printable single
  // characters (letters/digits/punctuation) and the named typing keys need a
  // modifier; dedicated keys (F-keys, media, Insert…) do not. Shift doesn't
  // count — shift+<char> still types.
  const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
  const isTypingKey = raw.length === 1 || NAMED_TYPING_KEYS.has(key);
  if (!hasModifier && isTypingKey) {
    return null;
  }
  const mods = MOD_ORDER.filter((m) =>
    m === 'ctrl' ? e.ctrlKey : m === 'alt' ? e.altKey : m === 'shift' ? e.shiftKey : e.metaKey,
  );
  return [...mods, key].join('+');
}

/** Pretty-print a stored combo, e.g. `alt+shift+v` → `Alt + Shift + V`. */
function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => (p === 'meta' ? 'Cmd' : p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' + ');
}

function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (combo: string | null) => void;
}): React.ReactElement {
  const styles = useStyles();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) {
return;
}
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const combo = eventToCombo(e);
      if (combo) {
        onChange(combo);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  const startRecording = useCallback(() => setRecording(true), []);
  const clear = useCallback(() => onChange(null), [onChange]);

  return (
    <div className={styles.controls}>
      <span className={styles.combo}>{recording ? 'Press keys…' : value ? formatCombo(value) : 'Not set'}</span>
      <Button onClick={startRecording}>{recording ? 'Recording…' : 'Record'}</Button>
      {value ? <Button variant="ghost" onClick={clear}>Clear</Button> : null}
    </div>
  );
}

export function SettingsModalHotkeysTab(): React.ReactElement {
  const styles = useStyles();
  const hotkey = useStore(persistedStoreApi.$atom).voiceToggleHotkey;

  const setVoiceHotkey = useCallback((combo: string | null) => {
    void persistedStoreApi.setKey('voiceToggleHotkey', combo);
  }, []);

  return (
    <div className={styles.root}>
      <div>
        <SectionLabel>Voice</SectionLabel>
        <Card>
          <div className={styles.row}>
            <div className={styles.label}>
              <Body1Strong>Voice input hotkey</Body1Strong>
              <Caption1>
                Records on the column your pointer is over (code deck) or the active chat. Tap to toggle (tap again to
                send); press and hold to talk, release to send. Use any key — typing keys (letters, digits, space,
                arrows) need a modifier (Ctrl/Alt/Cmd); dedicated keys (function, media, Insert…) work on their own.
              </Caption1>
            </div>
            <HotkeyRecorder value={hotkey} onChange={setVoiceHotkey} />
          </div>
        </Card>
      </div>
    </div>
  );
}
