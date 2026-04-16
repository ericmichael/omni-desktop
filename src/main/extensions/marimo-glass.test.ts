/**
 * Tests for marimo-glass — glass CSS file management and notebook migration.
 *
 * Uses real temp directories (no mocks). `ensureNotebookCssReference` does
 * string replacement on Python source files — edge cases matter.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARIMO_GLASS_CSS_FILENAME, MARIMO_GLASS_CSS_OFF, MARIMO_GLASS_CSS_ON } from '@/lib/marimo-glass-css';
import { ensureNotebookCssReference, getGlassCssPath, writeGlassCss } from '@/main/extensions/marimo-glass';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'marimo-glass-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getGlassCssPath
// ---------------------------------------------------------------------------

describe('getGlassCssPath', () => {
  it('joins the directory with the glass CSS filename', () => {
    expect(getGlassCssPath('/some/dir')).toBe(join('/some/dir', MARIMO_GLASS_CSS_FILENAME));
  });
});

// ---------------------------------------------------------------------------
// writeGlassCss
// ---------------------------------------------------------------------------

describe('writeGlassCss', () => {
  it('writes MARIMO_GLASS_CSS_ON content when enabled', async () => {
    await writeGlassCss(tmpDir, true);
    const content = readFileSync(getGlassCssPath(tmpDir), 'utf-8');
    expect(content).toBe(MARIMO_GLASS_CSS_ON);
  });

  it('writes MARIMO_GLASS_CSS_OFF content when disabled', async () => {
    await writeGlassCss(tmpDir, false);
    const content = readFileSync(getGlassCssPath(tmpDir), 'utf-8');
    expect(content).toBe(MARIMO_GLASS_CSS_OFF);
  });

  it('creates the directory if it does not exist', async () => {
    const nested = join(tmpDir, 'nested', 'pages');
    await writeGlassCss(nested, true);
    const content = readFileSync(getGlassCssPath(nested), 'utf-8');
    expect(content).toBe(MARIMO_GLASS_CSS_ON);
  });

  it('overwrites an existing file', async () => {
    await writeGlassCss(tmpDir, true);
    await writeGlassCss(tmpDir, false);
    const content = readFileSync(getGlassCssPath(tmpDir), 'utf-8');
    expect(content).toBe(MARIMO_GLASS_CSS_OFF);
  });
});

// ---------------------------------------------------------------------------
// ensureNotebookCssReference
// ---------------------------------------------------------------------------

describe('ensureNotebookCssReference', () => {
  it('replaces bare marimo.App() with css_file argument', async () => {
    const filePath = join(tmpDir, 'notebook.py');
    writeFileSync(filePath, 'import marimo\napp = marimo.App()\n');

    await ensureNotebookCssReference(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('app = marimo.App(css_file="marimo-glass.css")');
    expect(content).not.toContain('app = marimo.App()');
  });

  it('is a no-op when css_file is already present', async () => {
    const filePath = join(tmpDir, 'notebook.py');
    const original = 'app = marimo.App(css_file="custom.css")\n';
    writeFileSync(filePath, original);

    await ensureNotebookCssReference(filePath);

    expect(readFileSync(filePath, 'utf-8')).toBe(original);
  });

  it('is a no-op when marimo.App has existing arguments', async () => {
    const filePath = join(tmpDir, 'notebook.py');
    const original = 'app = marimo.App(width="medium")\n';
    writeFileSync(filePath, original);

    await ensureNotebookCssReference(filePath);

    // The function only matches the exact string `app = marimo.App()`.
    // `marimo.App(width=...)` does not match, so the file is unchanged.
    expect(readFileSync(filePath, 'utf-8')).toBe(original);
  });

  it('is a no-op when the file does not exist', async () => {
    const filePath = join(tmpDir, 'nonexistent.py');
    // Should not throw
    await ensureNotebookCssReference(filePath);
  });

  it('is a no-op when the file does not contain marimo.App()', async () => {
    const filePath = join(tmpDir, 'other.py');
    const original = 'import marimo\nprint("hello")\n';
    writeFileSync(filePath, original);

    await ensureNotebookCssReference(filePath);

    expect(readFileSync(filePath, 'utf-8')).toBe(original);
  });
});
