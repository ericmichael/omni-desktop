/**
 * Pure state machine for the PageView editor.
 *
 * States:
 * - loading: initial mount, waiting for disk content
 * - clean:   UI matches disk, no unsaved changes
 * - dirty:   local edits exist (with or without a save in flight)
 * - conflict: local edits AND an external change hit disk; user must pick a side
 *
 * Auto-reload: when `clean` and an external change arrives, silently update.
 * Conflict:    when `dirty` and an external change arrives, enter `conflict`.
 */

export type EditorState =
  | { kind: 'loading' }
  | { kind: 'clean'; content: string }
  | { kind: 'dirty'; content: string; saving: boolean }
  | { kind: 'conflict'; localContent: string; diskContent: string };

export type EditorEvent =
  | { type: 'loaded'; content: string }
  | { type: 'local-edit'; content: string }
  | { type: 'save-start' }
  | { type: 'save-done' }
  | { type: 'external-change'; content: string }
  | { type: 'external-delete' }
  | { type: 'resolve-use-disk' }
  | { type: 'resolve-keep-local' };

export function editorReducer(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case 'loaded':
      return { kind: 'clean', content: event.content };

    case 'local-edit':
      if (state.kind === 'loading') return state;
      if (state.kind === 'conflict') {
        // User kept typing through the banner — treat as "Keep my version":
        // local becomes authoritative, disk copy is discarded.
        return { kind: 'dirty', content: event.content, saving: false };
      }
      if (state.kind === 'clean' && state.content === event.content) return state;
      return {
        kind: 'dirty',
        content: event.content,
        saving: state.kind === 'dirty' ? state.saving : false,
      };

    case 'save-start':
      if (state.kind !== 'dirty') return state;
      return { ...state, saving: true };

    case 'save-done':
      if (state.kind !== 'dirty') return state;
      return { kind: 'clean', content: state.content };

    case 'external-change':
      if (state.kind === 'clean') {
        // Silent auto-reload — the magic sync experience.
        return { kind: 'clean', content: event.content };
      }
      if (state.kind === 'dirty') {
        return { kind: 'conflict', localContent: state.content, diskContent: event.content };
      }
      if (state.kind === 'conflict') {
        // Disk changed again while unresolved — refresh the disk side.
        return { ...state, diskContent: event.content };
      }
      return state;

    case 'external-delete':
      if (state.kind === 'clean') {
        return { kind: 'clean', content: '' };
      }
      if (state.kind === 'dirty') {
        return { kind: 'conflict', localContent: state.content, diskContent: '' };
      }
      return state;

    case 'resolve-use-disk':
      if (state.kind !== 'conflict') return state;
      return { kind: 'clean', content: state.diskContent };

    case 'resolve-keep-local':
      if (state.kind !== 'conflict') return state;
      return { kind: 'dirty', content: state.localContent, saving: false };
  }
}

/** Return the content the editor should currently display. */
export function currentContent(state: EditorState): string {
  switch (state.kind) {
    case 'loading':
      return '';
    case 'clean':
    case 'dirty':
      return state.content;
    case 'conflict':
      return state.localContent;
  }
}
