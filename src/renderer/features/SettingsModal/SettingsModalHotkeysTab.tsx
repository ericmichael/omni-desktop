/**
 * Hotkeys settings. Two voice bindings: one that toggles recording on the
 * hovered code-deck column / active chat, and a separate one that opens and
 * records to the superuser resident's DM. The recorder captures a key combo and
 * stores it in react-hotkeys-hook format (e.g. `alt+v`).
 */

import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Kbd } from '@/renderer/ds/ui/kbd';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { persistedStoreApi } from '@/renderer/services/store';

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
    m === 'ctrl' ? e.ctrlKey : m === 'alt' ? e.altKey : m === 'shift' ? e.shiftKey : e.metaKey
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
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Kbd className="min-w-24 justify-center">
        {recording ? 'Press keys…' : value ? formatCombo(value) : 'Not set'}
      </Kbd>
      <Button size="sm" variant="outline" onClick={startRecording} disabled={recording}>
        {recording ? 'Listening…' : value ? 'Change' : 'Set shortcut'}
      </Button>
      {value ? (
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

export function SettingsModalHotkeysTab(): React.ReactElement {
  const store = useStore(persistedStoreApi.$atom);
  const hotkey = store.voiceToggleHotkey;
  const globalHotkey = store.globalVoiceToggleHotkey;

  const setVoiceHotkey = useCallback((combo: string | null) => {
    void persistedStoreApi.setKey('voiceToggleHotkey', combo);
  }, []);
  const setGlobalVoiceHotkey = useCallback((combo: string | null) => {
    void persistedStoreApi.setKey('globalVoiceToggleHotkey', combo);
  }, []);

  return (
    <SettingsPane>
      <SettingsSection title="Voice">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-5">
              <FieldContent>
                <FieldLabel>Voice shortcut</FieldLabel>
                <FieldDescription>
                  Record in the active chat or the column under your pointer. Tap to toggle or hold to talk.
                </FieldDescription>
              </FieldContent>
              <HotkeyRecorder value={hotkey} onChange={setVoiceHotkey} />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-5">
              <FieldContent>
                <FieldLabel>Workspace agent shortcut</FieldLabel>
                <FieldDescription>Open your workspace agent and immediately start recording.</FieldDescription>
              </FieldContent>
              <HotkeyRecorder value={globalHotkey} onChange={setGlobalVoiceHotkey} />
            </Field>
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
}
