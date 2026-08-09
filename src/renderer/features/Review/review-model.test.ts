import { describe, expect, it } from 'vitest';

import {
  buildFileTree,
  firstAddedLine,
  languageForPath,
  linesFromHunks,
  numberUnified,
  splitUnifiedDiff,
  treeDirPaths,
} from './review-model';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@ function hello()',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export {};',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,2 @@',
  '+line one',
  '+line two',
  '\\ No newline at end of file',
].join('\n');

describe('splitUnifiedDiff', () => {
  it('splits a multi-file unified diff by post-image path', () => {
    const byPath = splitUnifiedDiff(DIFF);
    expect([...byPath.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(byPath.get('src/b.ts')).toContain('+line two');
  });

  it('returns an empty map for an empty diff', () => {
    expect(splitUnifiedDiff('').size).toBe(0);
  });
});

describe('numberUnified', () => {
  it('numbers lines by their position in the current file', () => {
    const lines = numberUnified(splitUnifiedDiff(DIFF).get('src/a.ts')!);
    expect(lines[0]).toEqual({ kind: 'separator', newLineno: null, content: 'function hello()' });
    expect(lines[1]).toEqual({ kind: 'context', newLineno: 1, content: 'const a = 1;' });
    expect(lines[2]).toEqual({ kind: 'delete', newLineno: null, content: 'const b = 2;' });
    expect(lines[3]).toEqual({ kind: 'add', newLineno: 2, content: 'const b = 3;' });
    expect(lines[4]).toEqual({ kind: 'add', newLineno: 3, content: 'const c = 4;' });
    expect(lines[5]).toEqual({ kind: 'context', newLineno: 4, content: 'export {};' });
  });

  it('drops header noise and keeps no-newline notes', () => {
    const lines = numberUnified(splitUnifiedDiff(DIFF).get('src/b.ts')!);
    expect(lines.map((line) => line.kind)).toEqual(['separator', 'add', 'add', 'note']);
    expect(lines[1]).toEqual({ kind: 'add', newLineno: 1, content: 'line one' });
  });
});

describe('numberUnified header noise', () => {
  it("drops the run-diff builder's bare 'new file' marker (not just git's 'new file mode')", () => {
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'new file',
      '--- /dev/null',
      '+++ b/notes.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n');
    const lines = numberUnified(splitUnifiedDiff(diff).get('notes.txt')!);
    expect(lines).toEqual([
      { kind: 'separator', newLineno: null, content: '' },
      { kind: 'add', newLineno: 1, content: 'hello' },
    ]);
  });

  it('yields no lines for a hunkless binary section', () => {
    const diff = ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n');
    expect(numberUnified(splitUnifiedDiff(diff).get('logo.png')!)).toEqual([]);
  });
});

describe('linesFromHunks', () => {
  const hunks = [
    {
      hunk_id: 'h1',
      index: 0,
      header: '@@ -1,2 +1,2 @@',
      section_heading: 'function hello()',
      old_start: 1,
      old_lines: 2,
      new_start: 1,
      new_lines: 2,
      lines: [
        { origin: 'context' as const, content: 'const a = 1;', old_lineno: 1, new_lineno: 1 },
        { origin: 'delete' as const, content: 'const b = 2;', old_lineno: 2, new_lineno: null },
        { origin: 'add' as const, content: 'const b = 3;', old_lineno: null, new_lineno: 2 },
        { origin: 'no_newline' as const, content: '', old_lineno: null, new_lineno: null },
      ],
    },
  ];

  it('projects structured hunks into the shared numbered grammar', () => {
    const lines = linesFromHunks(hunks);
    expect(lines[0]).toEqual({ kind: 'separator', newLineno: null, content: 'function hello()' });
    expect(lines[1]).toEqual({ kind: 'context', newLineno: 1, content: 'const a = 1;' });
    expect(lines[2]).toEqual({ kind: 'delete', newLineno: null, content: 'const b = 2;' });
    expect(lines[3]).toEqual({ kind: 'add', newLineno: 2, content: 'const b = 3;' });
    expect(lines[4]?.kind).toBe('note');
  });

  it('finds the first added line for open-file navigation', () => {
    expect(firstAddedLine(linesFromHunks(hunks))).toBe(2);
    expect(firstAddedLine([])).toBeUndefined();
  });
});

describe('languageForPath', () => {
  it('maps extensions and well-known filenames to shiki languages', () => {
    expect(languageForPath('src/renderer/App.tsx')).toBe('tsx');
    expect(languageForPath('scripts/build.py')).toBe('python');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('config.yaml')).toBe('yaml');
  });

  it('returns null for unknown or extensionless paths', () => {
    expect(languageForPath('LICENSE')).toBeNull();
    expect(languageForPath('assets/logo.xyzabc')).toBeNull();
    expect(languageForPath('.env')).toBeNull();
  });
});

describe('buildFileTree', () => {
  it('groups by directory, compressing single-child chains, dirs before files', () => {
    const tree = buildFileTree([
      'README.md',
      'src/renderer/features/Review/ReviewSurface.tsx',
      'src/renderer/features/Review/review-model.ts',
      'src/shared/types.ts',
    ]);
    expect(tree.map((node) => node.kind)).toEqual(['dir', 'file']);
    const src = tree[0]!;
    expect(src).toMatchObject({ kind: 'dir', name: 'src', path: 'src' });
    const children = (src as { children: unknown[] }).children as Array<Record<string, unknown>>;
    const renderer = children[0]!;
    const shared = children[1]!;
    expect(renderer).toMatchObject({
      kind: 'dir',
      name: 'renderer/features/Review',
      path: 'src/renderer/features/Review',
    });
    expect(shared).toMatchObject({ kind: 'dir', name: 'shared', path: 'src/shared' });
    expect((renderer.children as Array<{ name: string }>).map((n) => n.name)).toEqual([
      'review-model.ts',
      'ReviewSurface.tsx',
    ]);
  });

  it('lists every directory path for the default-expanded set', () => {
    const tree = buildFileTree(['a/b/one.ts', 'a/two.ts', 'root.ts']);
    expect(treeDirPaths(tree)).toEqual(['a', 'a/b']);
  });
});
