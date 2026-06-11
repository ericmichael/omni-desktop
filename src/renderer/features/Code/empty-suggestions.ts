/**
 * One-tap example tasks for empty conversations (UI/UX gameplan Phase 3):
 * a blank "How can I help you today?" teaches nothing — these show, by
 * doing, what an agent in this surface is for. Tapping one submits the
 * prompt immediately.
 */

export type EmptySuggestion = { label: string; prompt: string };

/** Ambient Chat surface — no project bound; the agent has the projects MCP. */
export const CHAT_SUGGESTIONS: ReadonlyArray<EmptySuggestion> = [
  {
    label: 'Plan my week',
    prompt: 'Review my projects and open tickets, then propose a focused plan for this week.',
  },
  {
    label: 'Triage my inbox',
    prompt:
      'Go through my inbox items and summarize what needs attention — suggest what to promote to tickets, defer, or drop.',
  },
  {
    label: 'Show me around',
    prompt: 'Give me a quick tour: what can you do from this chat, and what tools do you have access to?',
  },
];

/** Project column — a repo/workspace is mounted. */
export const COLUMN_SUGGESTIONS: ReadonlyArray<EmptySuggestion> = [
  {
    label: 'Explore the codebase',
    prompt:
      'Explore this repository and give me a concise architecture overview: key modules, entry points, and how they fit together.',
  },
  {
    label: 'Find a quick win',
    prompt: 'Find one small, safe improvement (a bug, dead code, or a missing test) and implement it.',
  },
  {
    label: 'Review recent changes',
    prompt: 'Summarize the most recent changes in this repo and flag anything risky or unfinished.',
  },
];
