/**
 * Push-to-talk mic button for local voice (Option A). Replaces the realtime
 * VoiceModal mic button when local models are active (see Input.tsx). Click to
 * record, click again to transcribe-and-send. Enabling voice mode registers the
 * agent's `speak` tool so the reply comes back as speech.
 */
import { Loader2Icon, MicIcon, SquareIcon } from 'lucide-react';
import { useContext, useEffect } from 'react';

import { useVoiceCapture } from '@/renderer/services/use-voice-capture';
import { getVoiceClient } from '@/renderer/services/voice-client';
import { $recordingScope, VoiceScopeContext } from '@/renderer/services/voice-recording';

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
    if (!cap.recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cap.cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cap.recording, cap.cancel]);

  const onClick = async () => {
    if (cap.busy) return;
    if (cap.recording) {
      const text = (await cap.stop()).trim();
      if (text) onSubmit(text);
      return;
    }
    // Warm up the sidecar (provisioning happens on first use) while the user
    // talks. The speak tool is already registered via the localVoiceEnabled
    // setting, so nothing else to toggle here.
    void getVoiceClient().start().catch(() => {});
    await cap.start().catch(() => {});
  };

  const label = cap.busy ? 'Transcribing…' : cap.recording ? 'Stop and send' : 'Voice input';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-2xl ${
        cap.recording ? 'bg-destructive/15' : 'hover:bg-accent/50'
      }`}
      aria-label={label}
      title={label}
    >
      {cap.busy ? (
        <Loader2Icon size={20} className="animate-spin text-foreground" />
      ) : cap.recording ? (
        <SquareIcon size={20} className="text-destructive" />
      ) : (
        <MicIcon size={20} className="text-foreground" />
      )}
    </button>
  );
}
