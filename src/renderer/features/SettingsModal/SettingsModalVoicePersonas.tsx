/**
 * Voice persona settings (local voice only). Lets the user pick the active
 * persona, create/edit/delete custom ones, and give a persona a cloned voice by
 * uploading an audio sample. Built-in personas (Default, Jarvis) are read-only;
 * "Duplicate" turns any of them into an editable custom copy — e.g. duplicate
 * Jarvis to give him your own cloned voice.
 *
 * A persona bundles its character (`instructions`) and its `voice`, so selecting
 * a persona switches both what the agent says and how it sounds.
 */

import { Delete20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { nanoid } from 'nanoid';
import { type ChangeEvent, useCallback, useMemo, useRef, useState } from 'react';

import { Button, Caption1, FormField, IconButton, Input, Radio, RadioGroup, Select, Textarea } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import { getVoiceClient } from '@/renderer/services/voice-client';
import {
  getActivePersona,
  getAllPersonas,
  PREDEFINED_VOICES,
  resolveVoiceArg,
  type VoicePersona,
  type VoiceRef,
} from '@/shared/voice-personas';

const newPersonaId = (): string => `custom-${nanoid()}`;

export function SettingsModalVoicePersonas(): React.ReactElement {
  const store = useStore(persistedStoreApi.$atom);
  const personas = getAllPersonas(store);
  const active = getActivePersona(store);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const setPersonas = useCallback((next: VoicePersona[]) => {
    void persistedStoreApi.setKey('voicePersonas', next);
  }, []);
  const selectPersona = useCallback((id: string) => {
    void persistedStoreApi.setKey('activeVoicePersonaId', id);
  }, []);

  /** Patch the active persona (custom only) in place. */
  const patchActive = useCallback(
    (patch: Partial<VoicePersona>) => {
      if (active.builtin) {
        return;
      }
      setPersonas((store.voicePersonas ?? []).map((p) => (p.id === active.id ? { ...p, ...patch } : p)));
    },
    [active, store.voicePersonas, setPersonas]
  );

  const onSelect = useCallback((e: ChangeEvent<HTMLSelectElement>) => selectPersona(e.target.value), [selectPersona]);

  const onCreate = useCallback(() => {
    const id = newPersonaId();
    const persona: VoicePersona = {
      id,
      name: 'New persona',
      builtin: false,
      instructions: '',
      voice: { kind: 'predefined', name: 'alba' },
    };
    setPersonas([...(store.voicePersonas ?? []), persona]);
    selectPersona(id);
  }, [store.voicePersonas, setPersonas, selectPersona]);

  /** Clone any persona (incl. built-ins) into an editable custom copy. */
  const onDuplicate = useCallback(() => {
    const id = newPersonaId();
    const copy: VoicePersona = { ...active, id, name: `${active.name} (copy)`, builtin: false };
    setPersonas([...(store.voicePersonas ?? []), copy]);
    selectPersona(id);
  }, [active, store.voicePersonas, setPersonas, selectPersona]);

  const onDelete = useCallback(() => {
    if (active.builtin) {
      return;
    }
    setPersonas((store.voicePersonas ?? []).filter((p) => p.id !== active.id));
    selectPersona('default');
  }, [active, store.voicePersonas, setPersonas, selectPersona]);

  const onChangeVoiceKind = useCallback(
    (kind: string) => {
      if (kind === 'predefined') {
        patchActive({ voice: { kind: 'predefined', name: 'alba' } });
      } else {
        fileInput.current?.click();
      } // 'clone' has no value until a file is picked
    },
    [patchActive]
  );

  const onChangePredefined = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => patchActive({ voice: { kind: 'predefined', name: e.target.value } }),
    [patchActive]
  );

  const onChangeName = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => patchActive({ name: e.target.value }),
    [patchActive]
  );

  const onChangeInstructions = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => patchActive({ instructions: e.target.value }),
    [patchActive]
  );

  const onChangeVoiceKindRadio = useCallback(
    (_: unknown, data: { value: string }) => onChangeVoiceKind(data.value),
    [onChangeVoiceKind]
  );

  const onUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || active.builtin) {
        return;
      }
      setBusy('Encoding voice sample…');
      try {
        const { file: stored, embeddingFile } = await getVoiceClient().importSample(active.id, file);
        const voice: VoiceRef = { kind: 'clone', embeddingFile, file: stored };
        patchActive({ voice });
      } catch (err) {
        setBusy(`Import failed: ${String(err)}`);
        return;
      }
      setBusy(null);
    },
    [active, patchActive]
  );

  const onPreview = useCallback(async () => {
    setBusy('Speaking…');
    try {
      await getVoiceClient().start();
      const line =
        active.id === 'jarvis' ? 'Good evening, sir. Jarvis at your service.' : `Hello, this is ${active.name}.`;
      await getVoiceClient().speak(line, resolveVoiceArg(active));
    } finally {
      setBusy(null);
    }
  }, [active]);

  const voiceKind = active.voice.kind;
  const cloneLabel = useMemo(() => {
    if (active.voice.kind !== 'clone') {
      return null;
    }
    if (active.voice.embeddingFile.startsWith('builtin:')) {
      return 'Bundled voice';
    }
    return active.voice.file ? active.voice.file.split('/').pop() : 'Cloned voice';
  }, [active.voice]);

  return (
    <>
      <FormField label="Persona">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Select value={active.id} onChange={onSelect} style={{ flex: 1 }}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.builtin ? '' : ' (custom)'}
              </option>
            ))}
          </Select>
          <Button onClick={onCreate}>New</Button>
          <Button onClick={onDuplicate}>Duplicate</Button>
          <Button onClick={onPreview} isDisabled={!!busy}>
            Preview
          </Button>
          {!active.builtin ? (
            <IconButton icon={<Delete20Regular />} aria-label="Delete persona" onClick={onDelete} />
          ) : null}
        </div>
      </FormField>

      {active.builtin ? (
        <Caption1>Built-in persona — duplicate it to customize the prompt or voice.</Caption1>
      ) : (
        <>
          <FormField label="Name">
            <Input value={active.name} onChange={onChangeName} />
          </FormField>
          <FormField label="Personality (system prompt)">
            <Textarea
              rows={6}
              value={active.instructions}
              placeholder="Describe how this persona talks and behaves…"
              onChange={onChangeInstructions}
            />
          </FormField>
        </>
      )}

      <FormField label="Voice">
        <RadioGroup layout="horizontal" value={voiceKind} onChange={onChangeVoiceKindRadio}>
          <Radio value="predefined" label="Predefined" disabled={active.builtin} />
          <Radio value="clone" label="Cloned (upload)" disabled={active.builtin} />
        </RadioGroup>
      </FormField>
      {voiceKind === 'predefined' ? (
        <FormField label="Predefined voice">
          <Select
            value={active.voice.kind === 'predefined' ? active.voice.name : 'alba'}
            onChange={onChangePredefined}
            disabled={active.builtin}
          >
            {PREDEFINED_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </FormField>
      ) : (
        <Caption1>{cloneLabel} · embedding is computed once on upload and reused.</Caption1>
      )}

      {busy ? <Caption1>{busy}</Caption1> : null}
      <input
        ref={fileInput}
        type="file"
        accept="audio/wav,audio/flac,audio/mpeg,audio/ogg,.wav,.flac,.mp3,.ogg"
        style={{ display: 'none' }}
        onChange={onUpload}
      />
    </>
  );
}
