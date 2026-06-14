/**
 * Voice personalities (local voice / Option A only).
 *
 * A persona ties together the agent's character (`instructions`, injected into
 * `additional_instructions` in voice mode) and the voice it speaks with
 * (`voice`, resolved to the string the TTS sidecar accepts). Because both live
 * on one object, "the voice is tied to the personality" falls out for free.
 *
 * Built-in personas live in code (never the store) so editing the Jarvis prompt
 * never needs a store migration. Custom personas live in `StoreData.voicePersonas`.
 *
 * A persona's voice is one of:
 *  - `predefined` — a named Pocket voice (`alba`, `javert`, …); passed straight
 *    through to the sidecar.
 *  - `clone` — a cloned voice. `embeddingFile` is the precomputed mimi embedding
 *    the sidecar loads directly (no per-utterance encode). For built-ins this is
 *    a `builtin:<id>` token resolved against the bundled `voice-sidecar/voices/`
 *    dir in the main process; for user uploads it's an absolute path to a `.npy`.
 *    `file` (the source wav) is kept only for user uploads, so the embedding can
 *    be regenerated if the TTS model bundle is ever bumped — built-ins are
 *    re-authored offline from masters we hold, so they ship embedding-only.
 */

export type VoiceRef = { kind: 'predefined'; name: string } | { kind: 'clone'; embeddingFile: string; file?: string };

export interface VoicePersona {
  /** `default` | `jarvis` | `custom-<uuid>`. */
  id: string;
  name: string;
  /** True for code-defined personas; false for user-created ones in the store. */
  builtin: boolean;
  /** Persona character, appended to additional_instructions in voice mode. */
  instructions: string;
  voice: VoiceRef;
}

/** Predefined Pocket TTS voices shipped in the `english_2026-04` bundle. */
export const PREDEFINED_VOICES = [
  'alba',
  'azelma',
  'cosette',
  'eponine',
  'fantine',
  'javert',
  'jean',
  'marius',
] as const;

const JARVIS_INSTRUCTIONS = [
  '## Persona: Jarvis',
  '',
  'You are **Jarvis** — a supremely capable AI butler and engineering assistant: polished, calm, and precise. Address the user as "sir" or "ma\'am" — out of style, not subservience.',
  '',
  '- Your wit is bone-dry and well-timed, never slapstick. A spirited production failure earns "A spirited failure, sir. Shall I contain the damage?"; an elegant solution, "Quite satisfactory, if I may say so."',
  '- You have opinions and share them with tact ("If I may suggest an alternative, sir…"), and you push back on bad ideas diplomatically but firmly.',
  '- You anticipate needs and manage complexity so the user does not have to. You notice things — a skipped test, an elderly dependency — and mention them at the right moment, as observations, not interruptions.',
  "- When you don't know something, you say so plainly, then investigate.",
  '- Keep spoken replies short and natural; this is a voice interface.',
].join('\n');

/** Neutral persona — preserves the pre-personas behaviour exactly. */
export const DEFAULT_PERSONA: VoicePersona = {
  id: 'default',
  name: 'Default',
  builtin: true,
  instructions: '',
  voice: { kind: 'predefined', name: 'alba' },
};

export const JARVIS_PERSONA: VoicePersona = {
  id: 'jarvis',
  name: 'Jarvis',
  builtin: true,
  // Ships embedding-only (voice-sidecar/voices/jarvis.emb.npy). If the embedding
  // is absent the main process falls back to a predefined voice (see VoiceService).
  instructions: JARVIS_INSTRUCTIONS,
  voice: { kind: 'clone', embeddingFile: 'builtin:jarvis' },
};

export const BUILTIN_VOICE_PERSONAS: readonly VoicePersona[] = [DEFAULT_PERSONA, JARVIS_PERSONA];

/**
 * Predefined fallback voice for a built-in clone persona whose bundled embedding
 * is missing from the build. Keeps the persona audible instead of erroring.
 */
export const BUILTIN_VOICE_FALLBACKS: Record<string, string> = {
  jarvis: 'javert',
};

type PersonaStore = {
  voicePersonas?: VoicePersona[];
  activeVoicePersonaId?: string;
};

/** Built-ins first, then user-created personas from the store. */
export const getAllPersonas = (store: PersonaStore): VoicePersona[] => [
  ...BUILTIN_VOICE_PERSONAS,
  ...(store.voicePersonas ?? []),
];

/** The selected persona, or Default when nothing is selected / the id is stale. */
export const getActivePersona = (store: PersonaStore): VoicePersona =>
  getAllPersonas(store).find((p) => p.id === store.activeVoicePersonaId) ?? DEFAULT_PERSONA;

/**
 * Resolve a persona's voice to the single string the renderer hands to
 * `speak()` / the TTS sidecar: a predefined name, a `builtin:<id>` token, or an
 * absolute `.npy` path. Built-in tokens and `.npy` paths are resolved further in
 * the main process (VoiceService) before they reach the sidecar.
 */
export const resolveVoiceArg = (persona: VoicePersona): string =>
  persona.voice.kind === 'predefined' ? persona.voice.name : persona.voice.embeddingFile;
