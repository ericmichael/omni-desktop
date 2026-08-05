/**
 * Push-to-talk mic button for local voice (Option A). Replaces the realtime
 * VoiceModal mic button when local models are active (see Input.tsx). Click to
 * record, click again to transcribe-and-send. Enabling voice mode registers the
 * agent's `speak` tool so the reply comes back as speech.
 */
import { MicIcon, SquareIcon } from 'lucide-react';
import { useContext, useEffect, useRef } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { useVoiceCapture } from '@/renderer/services/use-voice-capture';
import { getVoiceClient } from '@/renderer/services/voice-client';
import { $recordingScope, registerVoiceMic, VoiceScopeContext } from '@/renderer/services/voice-recording';

export function LocalVoiceButton({ onSubmit }: { onSubmit: (text: string) => void }) {
  const cap = useVoiceCapture();
  const scope = useContext(VoiceScopeContext);

  // Publish this column's scope while recording so the deck column can glow.
  useEffect(() => {
    if (cap.recording && scope) {
      $recordingScope.set(scope);
      return () => $recordingScope.set(null);
    }
  }, [cap.recording, scope]);

  // Escape cancels recording — discards the audio, sends nothing.
  useEffect(() => {
    if (!cap.recording) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cap.cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cap.recording, cap.cancel]);

  // Begin capture. If a push-to-talk release lands before the mic has actually
  // started (very fast tap), `pendingStop` makes us stop-and-send immediately.
  const pendingStopRef = useRef(false);
  const startRec = async () => {
    if (cap.busy || cap.recording) {
      return;
    }
    pendingStopRef.current = false;
    // Warm up the sidecar (provisioning happens on first use) while the user
    // talks. The speak tool is already registered via the localVoiceEnabled
    // setting, so nothing else to toggle here.
    void getVoiceClient()
      .start()
      .catch(() => {});
    await cap.start().catch(() => {});
    if (pendingStopRef.current) {
      pendingStopRef.current = false;
      await stopAndSend();
    }
  };
  const stopAndSend = async () => {
    if (!cap.recording) {
      pendingStopRef.current = true; // release arrived before start finished
      return;
    }
    const text = (await cap.stop()).trim();
    if (text) {
      onSubmit(text);
    }
  };
  const onClick = () => {
    if (cap.busy) {
      return;
    }
    if (cap.recording) {
      void stopAndSend();
    } else {
      void startRec();
    }
  };

  // Register this mic so the global voice hotkey can drive it. The ref keeps the
  // registered controls object stable while always invoking the latest closures.
  const ctlRef = useRef({ toggle: onClick, start: startRec, stop: stopAndSend, recording: cap.recording });
  ctlRef.current = { toggle: onClick, start: startRec, stop: stopAndSend, recording: cap.recording };
  useEffect(() => {
    if (!scope) {
      return;
    }
    return registerVoiceMic(scope, {
      toggle: () => ctlRef.current.toggle(),
      start: () => void ctlRef.current.start(),
      stop: () => void ctlRef.current.stop(),
      isRecording: () => ctlRef.current.recording,
    });
  }, [scope]);

  const label = cap.busy ? 'Transcribing…' : cap.recording ? 'Stop and send' : 'Voice input';

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      className={cap.recording ? 'rounded-2xl bg-destructive/15 hover:bg-destructive/20' : 'rounded-2xl'}
      aria-label={label}
      title={label}
    >
      {cap.busy ? (
        <Spinner className="size-4 text-foreground" />
      ) : cap.recording ? (
        <SquareIcon className="size-4 text-destructive" />
      ) : (
        <MicIcon className="size-4 text-foreground" />
      )}
    </Button>
  );
}
