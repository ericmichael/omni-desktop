import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Pages are stored at `<basePath>/<projectId>/<pageId>.md`.
 *
 * Keyed by stable id (not slug) so project renames are pure DB ops with no
 * filesystem churn. The launcher and MCP server share this layout — both
 * write into the same `<config>/pages` tree so neither overwrites the other.
 */

export function getPageDir(basePath: string, projectId: string): string {
  return join(basePath, projectId);
}

export function getPagePath(basePath: string, projectId: string, pageId: string): string {
  return join(getPageDir(basePath, projectId), `${pageId}.md`);
}

export function readPageContent(basePath: string, projectId: string, pageId: string): string | null {
  try {
    return readFileSync(getPagePath(basePath, projectId, pageId), 'utf-8');
  } catch {
    return null;
  }
}

export function writePageContent(basePath: string, projectId: string, pageId: string, content: string): void {
  const filePath = getPagePath(basePath, projectId, pageId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

export function deletePageContent(basePath: string, projectId: string, pageId: string): void {
  try {
    unlinkSync(getPagePath(basePath, projectId, pageId));
  } catch {
    // ignore if file doesn't exist
  }
}

export function deleteProjectPages(basePath: string, projectId: string): void {
  try {
    rmSync(getPageDir(basePath, projectId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
