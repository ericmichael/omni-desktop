/**
 * Inline voice dock — the hosted-voice surface that replaced the
 * full-screen VoiceModal. Sits at the top of the composer stack, above the
 * pill row, for as long as a realtime session is active: the orb (animated
 * by the session machine's derived state + live audio level). Nothing
 * else: the composer's own buttons own mute and hang-up while a call runs,
 * so a second copy here would just be two of each on screen. Above the
 * pills rather than under them because a live call is the session's
 * headline, not another composer row.
 *
 * Transcripts do NOT render here — they stream into the real MessageList
 * via the machine's items (merged by the host). Tool approvals arrive as
 * the chat's normal approval cards over /ws; the dock needs no approval UI.
 * Tapping the orb while it speaks interrupts (barge-in).
 */
import { useSelector } from '@xstate/react';

import type { RealtimeVoice } from '@/renderer/omniagents-ui/hooks/use-realtime-voice';
import { realtimeVoiceLevel } from '@/renderer/services/realtime-voice';
import { voiceActive, voiceOrbState, voicePhase } from '@/shared/machines/voice-session.machine';

import Orb from './Orb';

export function VoiceDock({ voice }: { voice: RealtimeVoice }) {
  const active = useSelector(voice.actor, voiceActive);
  const phase = useSelector(voice.actor, voicePhase);
  const orbState = useSelector(voice.actor, voiceOrbState);
  const muted = useSelector(voice.actor, (s) => s.context.muted);
  const activeTool = useSelector(voice.actor, (s) => s.context.activeTool);

  if (!active) {
    return null;
  }

  return (
    // The canvas is mostly transparent — the blob's diameter is roughly
    // `orbScale` × the square, so an idle orb already carries ~64px of empty
    // canvas per side at this size. Keep the real padding minimal and let
    // that be the breathing room.
    <div className="flex justify-center bg-card/60 px-3 pt-1">
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={() => {
            if (phase === 'speaking') {
              voice.interrupt();
            } else if (muted) {
              voice.toggleMute();
            }
          }}
          className="size-48 cursor-pointer bg-transparent p-0"
          aria-label={phase === 'speaking' ? 'Interrupt' : muted ? 'Unmute' : 'Voice session'}
        >
          <Orb state={orbState} toolActive={Boolean(activeTool)} levelSource={realtimeVoiceLevel} />
        </button>
      </div>
    </div>
  );
}
