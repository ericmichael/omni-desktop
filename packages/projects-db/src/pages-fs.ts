import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export function getPageDir(basePath: string, projectSlug: string): string {
  return join(basePath, projectSlug, 'pages');
}

export function getPagePath(basePath: string, projectSlug: string, pageId: string): string {
  return join(getPageDir(basePath, projectSlug), `${pageId}.md`);
}

export function readPageContent(basePath: string, projectSlug: string, pageId: string): string | null {
  try {
    return readFileSync(getPagePath(basePath, projectSlug, pageId), 'utf-8');
  } catch {
    return null;
  }
}

export function writePageContent(basePath: string, projectSlug: string, pageId: string, content: string): void {
  const filePath = getPagePath(basePath, projectSlug, pageId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

export function deletePageContent(basePath: string, projectSlug: string, pageId: string): void {
  try {
    unlinkSync(getPagePath(basePath, projectSlug, pageId));
  } catch {
    // ignore if file doesn't exist
  }
}

export function deleteProjectPages(basePath: string, projectSlug: string): void {
  try {
    rmSync(join(basePath, projectSlug), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
