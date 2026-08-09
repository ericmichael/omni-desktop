import type { BundledLanguage } from 'shiki';

import type { GitDiffHunk } from '@/renderer/omniagents-ui/rpc/git';

/**
 * Presentation logic for the Review surface: both scopes feed one display
 * grammar — numbered diff lines where the number is the line's position in
 * the file AS IT EXISTS NOW (deleted lines carry no number; they are
 * events between lines, marked only by `-`). Pure and unit-testable (the
 * launcher port of the Ink TUI's ``review-model``).
 */

export type ReviewDiffLine = {
  kind: 'add' | 'delete' | 'context' | 'note' | 'separator';
  newLineno: number | null;
  content: string;
};

/**
 * One unified diff covering many files → per-file raw line arrays, keyed
 * by the post-image path. Files listed in the run diff's `files` but
 * absent here (truncation, binary) simply have no entry.
 */
export function splitUnifiedDiff(diff: string): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (header) {
      current = [];
      byPath.set(header[2]!, current);
      continue;
    }
    current?.push(line);
  }
  return byPath;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/**
 * Raw unified-diff text (one file's section of the turn record) →
 * numbered display lines. The `@@` headers seed the counter and render as
 * separators carrying git's section heading.
 *
 * Noise is dropped by grammar, not by prefix list: everything before the
 * section's first `@@` is file-header material (`index …`, `--- `/`+++ `,
 * git's `new file mode 100644`, the run-diff builder's bare `new file`,
 * `Binary files … differ`, rename/copy markers), and inside a hunk only
 * `+` / `-` / `\` / space lines are content. A prefix list can't keep up
 * with header variants — treating "n" as context is how a bare `new file`
 * once rendered as the mystery line `0 ew file`.
 */
export function numberUnified(rawLines: string[]): ReviewDiffLine[] {
  const out: ReviewDiffLine[] = [];
  let newNo = 0;
  let inHunk = false;
  for (const line of rawLines) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      inHunk = true;
      newNo = parseInt(header[2]!, 10);
      out.push({ kind: 'separator', newLineno: null, content: header[3]?.trim() ?? '' });
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', newLineno: newNo, content: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith('-')) {
      out.push({ kind: 'delete', newLineno: null, content: line.slice(1) });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'note', newLineno: null, content: line });
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'context', newLineno: newNo, content: line.slice(1) });
      newNo += 1;
    }
    // Anything else inside a hunk (a truncation artifact, the trailing
    // empty string from the final newline split) is not diff content.
  }
  return out;
}

/**
 * Structured hunks (the git RPC's working-tree diff) → the same numbered
 * display lines, so both scopes render through one component.
 */
export function linesFromHunks(hunks: GitDiffHunk[]): ReviewDiffLine[] {
  const out: ReviewDiffLine[] = [];
  for (const hunk of hunks) {
    out.push({ kind: 'separator', newLineno: null, content: hunk.section_heading ?? '' });
    for (const line of hunk.lines) {
      switch (line.origin) {
        case 'add':
          out.push({ kind: 'add', newLineno: line.new_lineno, content: line.content });
          break;
        case 'delete':
          out.push({ kind: 'delete', newLineno: null, content: line.content });
          break;
        case 'no_newline':
          out.push({ kind: 'note', newLineno: null, content: '\\ No newline at end of file' });
          break;
        default:
          out.push({ kind: 'context', newLineno: line.new_lineno, content: line.content });
      }
    }
  }
  return out;
}

export function firstAddedLine(lines: ReviewDiffLine[]): number | undefined {
  return lines.find((line) => line.kind === 'add' && line.newLineno !== null)?.newLineno ?? undefined;
}

// ----- sidebar file tree ----------------------------------------------------

export type ReviewTreeDir = { kind: 'dir'; name: string; path: string; children: ReviewTreeNode[] };
export type ReviewTreeFile = { kind: 'file'; name: string; path: string };
export type ReviewTreeNode = ReviewTreeDir | ReviewTreeFile;

type MutableDir = { name: string; path: string; dirs: Map<string, MutableDir>; files: string[] };

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Changed-file paths → a directory tree for the sidebar. Single-child
 * directory chains compress into one node ("src/renderer/features"), the
 * VS Code compact-folders reading; directories sort before files.
 */
export function buildFileTree(paths: string[]): ReviewTreeNode[] {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (const name of parts.slice(0, -1)) {
      let child = node.dirs.get(name);
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, dirs: new Map(), files: [] };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push(path);
  }
  const toNodes = (dir: MutableDir): ReviewTreeNode[] => {
    const dirs: ReviewTreeDir[] = [...dir.dirs.values()].map((child) => {
      let compact = child;
      let name = child.name;
      while (compact.files.length === 0 && compact.dirs.size === 1) {
        compact = [...compact.dirs.values()][0]!;
        name = `${name}/${compact.name}`;
      }
      return { kind: 'dir', name, path: compact.path, children: toNodes(compact) };
    });
    const files: ReviewTreeFile[] = dir.files.map((path) => ({
      kind: 'file',
      name: path.split('/').pop() ?? path,
      path,
    }));
    dirs.sort((a, b) => compare(a.name, b.name));
    files.sort((a, b) => compare(a.name, b.name));
    return [...dirs, ...files];
  };
  return toNodes(root);
}

/** Every directory path in the tree — the default-expanded set. */
export function treeDirPaths(nodes: ReviewTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ReviewTreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'dir') {
        out.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  svelte: 'svelte',
  vue: 'vue',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  proto: 'proto',
  lua: 'lua',
  php: 'php',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  scala: 'scala',
  dart: 'dart',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  tf: 'terraform',
  hcl: 'hcl',
  diff: 'diff',
  patch: 'diff',
};

/** Shiki language for a workspace path, or null when highlighting would
 *  add nothing (unknown extension, plain text). */
export function languageForPath(path: string): BundledLanguage | null {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base === 'dockerfile') {
    return 'dockerfile';
  }
  if (base === 'makefile') {
    return 'make';
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1)] ?? null;
}
