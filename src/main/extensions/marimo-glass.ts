import { promises as fs } from 'fs';
import path from 'path';

import {
  MARIMO_GLASS_CSS_FILENAME,
  MARIMO_GLASS_CSS_OFF,
  MARIMO_GLASS_CSS_ON,
} from '@/lib/marimo-glass-css';
import { ensureDirectory } from '@/main/util';

/**
 * Returns the absolute path to the marimo glass stylesheet for a given
 * project. Lives next to the notebook `.py` files so marimo's per-notebook
 * `css_file` argument (which is resolved relative to the notebook file) can
 * reference it as `"marimo-glass.css"`.
 */
export const getGlassCssPath = (projectPagesDir: string): string =>
  path.join(projectPagesDir, MARIMO_GLASS_CSS_FILENAME);

/**
 * Idempotently write the glass stylesheet for a project's notebook directory,
 * with content selected by the `enabled` flag. Always writes — overwrite is
 * the point, since toggling glass mode on/off rewrites this file.
 */
export const writeGlassCss = async (
  projectPagesDir: string,
  enabled: boolean
): Promise<void> => {
  await ensureDirectory(projectPagesDir);
  const filePath = getGlassCssPath(projectPagesDir);
  const content = enabled ? MARIMO_GLASS_CSS_ON : MARIMO_GLASS_CSS_OFF;
  await fs.writeFile(filePath, content, 'utf-8');
};

/**
 * Migrate an existing notebook file in place to reference the glass CSS.
 *
 * Only acts on the very specific shape `marimo.App()` (zero arguments). If
 * the notebook already has any args on the App constructor we leave it alone
 * — replacing arbitrary Python with regex would be reckless, and the user
 * (or marimo's own UI) can adjust an existing config manually.
 */
export const ensureNotebookCssReference = async (notebookPath: string): Promise<void> => {
  let content: string;
  try {
    content = await fs.readFile(notebookPath, 'utf-8');
  } catch {
    return;
  }
  const bare = 'app = marimo.App()';
  if (!content.includes(bare)) {
return;
}
  if (content.includes('css_file')) {
return;
}
  const next = content.replace(bare, 'app = marimo.App(css_file="marimo-glass.css")');
  await fs.writeFile(notebookPath, next, 'utf-8');
};
