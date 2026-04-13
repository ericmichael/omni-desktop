import { describe, expect, it } from 'vitest';

import { currentContent, editorReducer, type EditorState } from '@/lib/page-editor-state';

const loading: EditorState = { kind: 'loading' };
const clean = (content: string): EditorState => ({ kind: 'clean', content });
const dirty = (content: string, saving = false): EditorState => ({ kind: 'dirty', content, saving });
const conflict = (localContent: string, diskContent: string): EditorState => ({
  kind: 'conflict',
  localContent,
  diskContent,
});

describe('editorReducer', () => {
  describe('loaded', () => {
    it('transitions loading → clean', () => {
      expect(editorReducer(loading, { type: 'loaded', content: 'hello' })).toEqual(clean('hello'));
    });

    it('replaces content when already clean', () => {
      expect(editorReducer(clean('old'), { type: 'loaded', content: 'new' })).toEqual(clean('new'));
    });
  });

  describe('local-edit', () => {
    it('is ignored while loading', () => {
      expect(editorReducer(loading, { type: 'local-edit', content: 'x' })).toBe(loading);
    });

    it('transitions clean → dirty on real change', () => {
      expect(editorReducer(clean('a'), { type: 'local-edit', content: 'ab' })).toEqual(dirty('ab'));
    });

    it('is a no-op when clean and content is identical', () => {
      const s = clean('same');
      expect(editorReducer(s, { type: 'local-edit', content: 'same' })).toBe(s);
    });

    it('preserves saving=true across edits while already dirty', () => {
      expect(editorReducer(dirty('a', true), { type: 'local-edit', content: 'ab' })).toEqual(dirty('ab', true));
    });

    it('resolves conflict implicitly by treating edit as Keep-my-version', () => {
      expect(editorReducer(conflict('local', 'disk'), { type: 'local-edit', content: 'local2' })).toEqual(
        dirty('local2')
      );
    });
  });

  describe('save-start / save-done', () => {
    it('save-start marks dirty as saving', () => {
      expect(editorReducer(dirty('x'), { type: 'save-start' })).toEqual(dirty('x', true));
    });

    it('save-start is a no-op when not dirty', () => {
      expect(editorReducer(clean('x'), { type: 'save-start' })).toEqual(clean('x'));
    });

    it('save-done transitions dirty → clean', () => {
      expect(editorReducer(dirty('x', true), { type: 'save-done' })).toEqual(clean('x'));
    });

    it('save-done is a no-op when not dirty (stale callback)', () => {
      // e.g. an external-change arrived between save-start and save-done and flipped us to conflict.
      const c = conflict('l', 'd');
      expect(editorReducer(c, { type: 'save-done' })).toBe(c);
    });
  });

  describe('external-change', () => {
    it('clean → clean (silent auto-reload)', () => {
      expect(editorReducer(clean('old'), { type: 'external-change', content: 'new' })).toEqual(clean('new'));
    });

    it('dirty → conflict', () => {
      expect(editorReducer(dirty('local'), { type: 'external-change', content: 'disk' })).toEqual(
        conflict('local', 'disk')
      );
    });

    it('conflict → conflict (refresh disk side)', () => {
      expect(editorReducer(conflict('l', 'd1'), { type: 'external-change', content: 'd2' })).toEqual(
        conflict('l', 'd2')
      );
    });

    it('loading → loading (ignored)', () => {
      expect(editorReducer(loading, { type: 'external-change', content: 'x' })).toBe(loading);
    });
  });

  describe('external-delete', () => {
    it('clean → clean with empty content', () => {
      expect(editorReducer(clean('x'), { type: 'external-delete' })).toEqual(clean(''));
    });

    it('dirty → conflict with empty disk', () => {
      expect(editorReducer(dirty('local'), { type: 'external-delete' })).toEqual(conflict('local', ''));
    });

    it('conflict is unchanged by delete', () => {
      const c = conflict('l', 'd');
      expect(editorReducer(c, { type: 'external-delete' })).toBe(c);
    });
  });

  describe('conflict resolution', () => {
    it('resolve-use-disk: conflict → clean with disk content', () => {
      expect(editorReducer(conflict('local', 'disk'), { type: 'resolve-use-disk' })).toEqual(clean('disk'));
    });

    it('resolve-keep-local: conflict → dirty with local content', () => {
      expect(editorReducer(conflict('local', 'disk'), { type: 'resolve-keep-local' })).toEqual(dirty('local'));
    });

    it('resolution is a no-op when not in conflict', () => {
      expect(editorReducer(clean('x'), { type: 'resolve-use-disk' })).toEqual(clean('x'));
      expect(editorReducer(clean('x'), { type: 'resolve-keep-local' })).toEqual(clean('x'));
    });
  });

  describe('currentContent', () => {
    it('returns empty string while loading', () => {
      expect(currentContent(loading)).toBe('');
    });

    it('returns content for clean and dirty', () => {
      expect(currentContent(clean('c'))).toBe('c');
      expect(currentContent(dirty('d'))).toBe('d');
    });

    it('returns local content while in conflict (user sees their in-progress edits)', () => {
      expect(currentContent(conflict('local', 'disk'))).toBe('local');
    });
  });

  describe('end-to-end scenario: external edit while typing', () => {
    it('handles the classic race: user dirty → external change → Keep my version → save completes', () => {
      let s: EditorState = clean('initial');
      s = editorReducer(s, { type: 'local-edit', content: 'initial and more' });
      expect(s.kind).toBe('dirty');

      s = editorReducer(s, { type: 'external-change', content: 'someone else edited' });
      expect(s.kind).toBe('conflict');

      s = editorReducer(s, { type: 'resolve-keep-local' });
      expect(s).toEqual(dirty('initial and more'));

      s = editorReducer(s, { type: 'save-start' });
      expect(s).toEqual(dirty('initial and more', true));

      s = editorReducer(s, { type: 'save-done' });
      expect(s).toEqual(clean('initial and more'));
    });

    it('handles the "walk away, edit elsewhere, come back" case: clean → external change → clean', () => {
      let s: EditorState = clean('v1');
      s = editorReducer(s, { type: 'external-change', content: 'v2' });
      expect(s).toEqual(clean('v2'));
      // User comes back and continues editing; starts from v2.
      s = editorReducer(s, { type: 'local-edit', content: 'v2 + edits' });
      expect(s).toEqual(dirty('v2 + edits'));
    });
  });
});
