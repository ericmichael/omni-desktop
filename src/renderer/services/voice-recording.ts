/**
 * Bridges the (deeply-nested) mic recording state to the deck-column border so
 * the column being spoken into can show an animated "AI" glow.
 *
 * `$recordingScope` holds the scope id of the column currently capturing audio
 * (the code tab's id). The mic button (`LocalVoiceButton`) writes it while
 * recording, reading its scope from `VoiceScopeContext` (provided per column by
 * `CodeTabContent`). `CodeDeck` reads the store and glows the matching column.
 */
import { createContext } from 'react';

import { atom } from 'nanostores';

/** Scope id (code tab id) of the column currently recording, or null. */
export const $recordingScope = atom<string | null>(null);

/** Per-column scope id, provided around the agent UI subtree. */
export const VoiceScopeContext = createContext<string | null>(null);

/**
 * Live mic level (0..1), updated by the capture meter every animation frame and
 * read by the glow overlay. A plain mutable holder (not a store) so 60fps
 * updates never trigger React re-renders.
 */
export const voiceLevel = { current: 0 };
