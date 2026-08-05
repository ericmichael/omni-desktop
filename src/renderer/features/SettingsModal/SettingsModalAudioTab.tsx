import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Progress } from '@/renderer/ds/ui/progress';
import { Switch } from '@/renderer/ds/ui/switch';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { SettingsModalVoicePersonas } from '@/renderer/features/SettingsModal/SettingsModalVoicePersonas';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AudioSettings } from '@/shared/types';

type DeviceOption = { deviceId: string; label: string };

const NONE_OPTION = '__default__';

function deviceLabel(d: MediaDeviceInfo, fallbackIndex: number): string {
  if (d.label) {
    return d.label;
  }
  const kind = d.kind === 'audioinput' ? 'Microphone' : 'Output';
  return `${kind} ${fallbackIndex + 1}`;
}

export const SettingsModalAudioTab = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const settings = store.audioSettings;

  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputMeter = useInputLevelMeter(settings.inputDeviceId);
  const outputAudioElRef = useRef<HTMLAudioElement | null>(null);
  const outputTest = useOutputTestTone(settings.outputDeviceId, outputAudioElRef);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('Audio device enumeration is not supported in this environment.');
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      let inIdx = 0;
      let outIdx = 0;
      const ins: DeviceOption[] = [];
      const outs: DeviceOption[] = [];
      let anyLabelMissing = false;
      for (const d of devices) {
        if (d.kind === 'audioinput') {
          if (!d.label) {
            anyLabelMissing = true;
          }
          ins.push({ deviceId: d.deviceId, label: deviceLabel(d, inIdx++) });
        } else if (d.kind === 'audiooutput') {
          if (!d.label) {
            anyLabelMissing = true;
          }
          outs.push({ deviceId: d.deviceId, label: deviceLabel(d, outIdx++) });
        }
      }
      setInputs(ins);
      setOutputs(outs);
      setNeedsPermission(anyLabelMissing && ins.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enumerate audio devices');
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }
    const onChange = () => {
      void refresh();
    };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, [refresh]);

  const grantPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone permission denied');
    }
  }, [refresh]);

  const update = useCallback((patch: Partial<AudioSettings>) => {
    void persistedStoreApi.setKey('audioSettings', { ...persistedStoreApi.$atom.get().audioSettings, ...patch });
  }, []);

  const onChangeInput = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      update({ inputDeviceId: e.target.value === NONE_OPTION ? null : e.target.value });
    },
    [update]
  );
  const onChangeOutput = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      update({ outputDeviceId: e.target.value === NONE_OPTION ? null : e.target.value });
    },
    [update]
  );
  const onChangeEcho = useCallback((checked: boolean) => update({ echoCancellation: checked }), [update]);
  const onChangeNoise = useCallback((checked: boolean) => update({ noiseSuppression: checked }), [update]);
  const onChangeGain = useCallback((checked: boolean) => update({ autoGainControl: checked }), [update]);

  return (
    <SettingsPane>
      <SettingsSection title="Devices">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            {needsPermission && (
              <div className="flex items-center gap-4">
                <span className="text-xs text-muted-foreground">
                  Grant microphone access once to show device names.
                </span>
                <Button size="sm" variant="ghost" onClick={grantPermission}>
                  Allow
                </Button>
              </div>
            )}
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Input (microphone)</FieldLabel>
              </div>
              <div className="flex flex-col gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <Select value={settings.inputDeviceId ?? NONE_OPTION} onChange={onChangeInput}>
                      <option value={NONE_OPTION}>System default</option>
                      {inputs.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button size="sm" variant="ghost" onClick={inputMeter.toggle} className="shrink-0 min-w-16">
                    {inputMeter.active ? 'Stop' : 'Test'}
                  </Button>
                </div>
                {inputMeter.active && <InputLevelBar level={inputMeter.level} />}
                {inputMeter.error && <span className="text-xs text-muted-foreground">{inputMeter.error}</span>}
              </div>
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Output (speaker)</FieldLabel>
              </div>
              <div className="flex flex-col gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <Select value={settings.outputDeviceId ?? NONE_OPTION} onChange={onChangeOutput}>
                      <option value={NONE_OPTION}>System default</option>
                      {outputs.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={outputTest.play}
                    disabled={outputTest.playing}
                    className="shrink-0 min-w-16"
                  >
                    {outputTest.playing ? 'Playing…' : 'Test'}
                  </Button>
                </div>
                <audio ref={outputAudioElRef} autoPlay className="hidden" />
                {outputTest.error && <span className="text-xs text-muted-foreground">{outputTest.error}</span>}
              </div>
            </Field>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection title="Processing">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Echo cancellation</FieldLabel>
              </div>
              <Switch checked={settings.echoCancellation} onCheckedChange={onChangeEcho} />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Noise suppression</FieldLabel>
              </div>
              <Switch checked={settings.noiseSuppression} onCheckedChange={onChangeNoise} />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Automatic gain control</FieldLabel>
              </div>
              <Switch checked={settings.autoGainControl} onCheckedChange={onChangeGain} />
            </Field>
            <p className="text-xs text-muted-foreground">
              Applies the next time Voice mode is opened. Disable processing if you use external DSP (e.g. a hardware
              mixer or system-level noise suppression).
            </p>
          </CardContent>
        </Card>
      </SettingsSection>

      {/* Personas shape the local voice's personality — only meaningful when
           local voice is on (AI tab → Voice → Local). */}
      {store.localVoiceEnabled && (
        <SettingsSection title="Personas">
          <Card>
            <CardContent>
              <SettingsModalVoicePersonas />
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      {error && <p className="text-xs text-muted-foreground">{error}</p>}
    </SettingsPane>
  );
});
SettingsModalAudioTab.displayName = 'SettingsModalAudioTab';

// ---------------------------------------------------------------------------
// Input level meter (hook + bar render)
// ---------------------------------------------------------------------------

function useInputLevelMeter(deviceId: string | null) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    analyserRef.current = null;
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
      streamRef.current = stream;
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;

      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        const a = analyserRef.current;
        if (!a) {
          return;
        }
        a.getFloatTimeDomainData(buf);
        // RMS → 0..1 with mild compression so the bar moves expressively.
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          sum += buf[i]! * buf[i]!;
        }
        const rms = Math.sqrt(sum / buf.length);
        const norm = Math.min(1, rms * 4);
        setLevel(norm);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start input preview');
      stop();
      setActive(false);
    }
  }, [deviceId, stop]);

  // Restart the stream when the device changes mid-preview so the meter
  // follows the user's selection without forcing a manual stop/start.
  useEffect(() => {
    if (!active) {
      return;
    }
    stop();
    void start();
    // start/stop are stable closures over deviceId via the dependency above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const toggle = useCallback(() => {
    if (active) {
      stop();
      setActive(false);
    } else {
      void start();
    }
  }, [active, start, stop]);

  return { active, level, error, toggle };
}

type InputLevelBarProps = {
  level: number;
};

const InputLevelBar = memo(({ level }: InputLevelBarProps) => {
  const pct = Math.round(level * 100);
  const clipping = level > 0.92;
  return (
    <div className="mt-1 flex items-center gap-2">
      <Progress
        value={pct}
        aria-label="Input level"
        className={`h-1.5 flex-1 bg-secondary [&_[data-slot=progress-indicator]]:duration-75 [&_[data-slot=progress-indicator]]:ease-linear ${clipping ? '[&_[data-slot=progress-indicator]]:bg-destructive' : ''}`}
      />
      <span className="min-w-8 text-right font-mono text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
});
InputLevelBar.displayName = 'InputLevelBar';

// ---------------------------------------------------------------------------
// Output test tone (hook + hidden sink element)
// ---------------------------------------------------------------------------

function useOutputTestTone(deviceId: string | null, audioElRef: React.RefObject<HTMLAudioElement | null>) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const play = useCallback(async () => {
    setError(null);
    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.55);
      osc.connect(gain);
      gain.connect(dest);

      const el = audioElRef.current;
      if (!el) {
        return;
      }
      el.srcObject = dest.stream;
      const setSink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      if (deviceId && typeof setSink === 'function') {
        try {
          await setSink.call(el, deviceId);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not set output device');
        }
      }
      await el.play().catch(() => {});
      osc.start(now);
      osc.stop(now + 0.6);
      setPlaying(true);
      osc.onended = () => {
        setPlaying(false);
        el.srcObject = null;
        void ctx.close();
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to play test tone');
      setPlaying(false);
    }
  }, [deviceId, audioElRef]);

  return { playing, error, play };
}
