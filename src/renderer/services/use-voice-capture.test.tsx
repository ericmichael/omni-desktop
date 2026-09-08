import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useVoiceCapture, type VoiceCapture } from './use-voice-capture';

const mocks = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('@/renderer/services/store', () => ({ persistedStoreApi: { $atom: { get: () => ({ audioSettings: {} }) } } }));
vi.mock('@/renderer/services/voice-client', () => ({ getVoiceClient: () => mocks }));
vi.mock('@/renderer/services/voice-recording', () => ({ voiceLevel: { current: 0 } }));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function setup(pending = false, failSetup = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const stopTrack = vi.fn();
  const close = vi.fn(async () => {});
  const disconnect = vi.fn();
  let grant!: () => void;
  const permission = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const getUserMedia = vi.fn(async () => {
    if (pending) {
      await permission;
    }
    return { getTracks: () => [{ stop: stopTrack }] };
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const node = { connect: vi.fn(), disconnect, onaudioprocess: undefined as any };
  vi.stubGlobal(
    'AudioContext',
    class {
      destination = {};
      sampleRate = 24000;
      close = close;
      createMediaStreamSource() {
        if (failSetup) {
          throw new Error('audio setup failed');
        }
        return { connect: vi.fn() };
      }
      createScriptProcessor() {
        return node;
      }
      createAnalyser() {
        return { fftSize: 256, getByteTimeDomainData: vi.fn(), disconnect };
      }
    }
  );
  let capture!: VoiceCapture;
  function Probe() {
    capture = useVoiceCapture();
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe />));
  return {
    get capture() {
      return capture;
    },
    stopTrack,
    close,
    disconnect,
    grant,
    getUserMedia,
    node,
  };
}

it.each([false, true])('releases microphone on unmount (permission pending=%s)', async (pending) => {
  const test = await setup(pending);
  const starting = test.capture.start();
  if (!pending) {
    await act(() => starting);
  }
  await act(async () => root!.unmount());
  root = undefined;
  test.grant();
  await starting;
  expect(test.stopTrack).toHaveBeenCalledOnce();
  expect(test.close).toHaveBeenCalledTimes(pending ? 0 : 1);
});

it('cancels pending permission and prevents duplicate acquisition', async () => {
  const test = await setup(true);
  const starting = test.capture.start();
  await test.capture.start();
  expect(test.getUserMedia).toHaveBeenCalledOnce();
  act(() => test.capture.cancel());
  test.grant();
  await starting;
  expect(test.stopTrack).toHaveBeenCalledOnce();
  expect(test.capture.recording).toBe(false);
});

it('releases acquired resources when audio setup fails', async () => {
  const test = await setup(false, true);
  await expect(test.capture.start()).rejects.toThrow('audio setup failed');
  expect(test.stopTrack).toHaveBeenCalledOnce();
  expect(test.close).toHaveBeenCalledOnce();
});

it.each(['cancel', 'unmount'])('discards transcription after %s', async (ending) => {
  const test = await setup();
  await act(() => test.capture.start());
  test.node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0.1, 0.2]) } });
  let complete!: (text: string) => void;
  mocks.transcribe.mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    })
  );
  let stopping!: Promise<string>;
  act(() => {
    stopping = test.capture.stop();
  });
  if (ending === 'cancel') {
    act(() => test.capture.cancel());
  } else {
    await act(async () => root!.unmount());
    root = undefined;
  }
  complete('must not send this');
  await expect(stopping).resolves.toBe('');
});
