import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, FormField, SectionLabel, Select, Switch } from '@/renderer/ds';
import { SettingsModalVoicePersonas } from '@/renderer/features/SettingsModal/SettingsModalVoicePersonas';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AudioSettings } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  description: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  sectionLabelSpaced: { marginTop: tokens.spacingVerticalM },
  permissionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  deviceCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    flex: 1,
    minWidth: 0,
  },
  deviceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  pickerWrap: { flex: 1, minWidth: 0 },
  testBtn: { flexShrink: 0, minWidth: '64px' },
  meter: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  meterTrack: {
    position: 'relative',
    flex: 1,
    height: '6px',
    backgroundColor: tokens.colorNeutralBackground5,
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
  },
  meterFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: tokens.colorBrandBackground,
    transitionProperty: 'width',
    transitionDuration: '60ms',
    transitionTimingFunction: 'linear',
  },
  meterFillClip: { backgroundColor: tokens.colorPaletteRedBackground3 },
  meterValue: {
    minWidth: '32px',
    textAlign: 'right',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
});

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
  const styles = useStyles();
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
    <div className={styles.root}>
      <SectionLabel>Devices</SectionLabel>
      <Card>
        {needsPermission && (
          <div className={styles.permissionRow}>
            <span className={styles.description}>
              Grant microphone access once to show device names.
            </span>
            <Button size="sm" variant="ghost" onClick={grantPermission}>
              Allow
            </Button>
          </div>
        )}
        <FormField label="Input (microphone)">
          <div className={styles.deviceCol}>
            <div className={styles.deviceRow}>
              <div className={styles.pickerWrap}>
                <Select value={settings.inputDeviceId ?? NONE_OPTION} onChange={onChangeInput}>
                  <option value={NONE_OPTION}>System default</option>
                  {inputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="sm" variant="ghost" onClick={inputMeter.toggle} className={styles.testBtn}>
                {inputMeter.active ? 'Stop' : 'Test'}
              </Button>
            </div>
            {inputMeter.active && <InputLevelBar level={inputMeter.level} styles={styles} />}
            {inputMeter.error && <span className={styles.description}>{inputMeter.error}</span>}
          </div>
        </FormField>
        <FormField label="Output (speaker)">
          <div className={styles.deviceCol}>
            <div className={styles.deviceRow}>
              <div className={styles.pickerWrap}>
                <Select value={settings.outputDeviceId ?? NONE_OPTION} onChange={onChangeOutput}>
                  <option value={NONE_OPTION}>System default</option>
                  {outputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="sm" variant="ghost" onClick={outputTest.play} isDisabled={outputTest.playing} className={styles.testBtn}>
                {outputTest.playing ? 'Playing…' : 'Test'}
              </Button>
            </div>
            <audio ref={outputAudioElRef} autoPlay style={{ display: 'none' }} />
            {outputTest.error && <span className={styles.description}>{outputTest.error}</span>}
          </div>
        </FormField>
      </Card>

      <SectionLabel className={styles.sectionLabelSpaced}>Processing</SectionLabel>
      <Card>
        <FormField label="Echo cancellation">
          <Switch checked={settings.echoCancellation} onCheckedChange={onChangeEcho} />
        </FormField>
        <FormField label="Noise suppression">
          <Switch checked={settings.noiseSuppression} onCheckedChange={onChangeNoise} />
        </FormField>
        <FormField label="Automatic gain control">
          <Switch checked={settings.autoGainControl} onCheckedChange={onChangeGain} />
        </FormField>
        <p className={styles.description}>
          Applies the next time Voice mode is opened. Disable processing if you use external
          DSP (e.g. a hardware mixer or system-level noise suppression).
        </p>
      </Card>

      {/* Personas shape the local voice's personality — only meaningful when
          local voice is on (AI tab → Voice → Local). */}
      {store.localVoiceEnabled && (
        <>
          <SectionLabel className={styles.sectionLabelSpaced}>Personas</SectionLabel>
          <Card>
            <SettingsModalVoicePersonas />
          </Card>
        </>
      )}

      {error && <p className={styles.description}>{error}</p>}
    </div>
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
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
  styles: ReturnType<typeof useStyles>;
};

const InputLevelBar = memo(({ level, styles }: InputLevelBarProps) => {
  const pct = Math.round(level * 100);
  const clipping = level > 0.92;
  return (
    <div className={styles.meter}>
      <div className={styles.meterTrack}>
        <div
          className={`${styles.meterFill} ${clipping ? styles.meterFillClip : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={styles.meterValue}>{pct}%</span>
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
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
