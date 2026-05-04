import extract from 'extract-zip';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

import type { SkillEntry, SkillSource, StoreData } from '@/shared/types';

const SKILL_FILENAME = 'SKILL.md';

export type SkillFrontmatter = {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
};

export type SkillStore = {
  get<K extends keyof StoreData>(key: K): StoreData[K];
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
};

/** Active skills — the runtime scans this directory. */
export function getSkillsDir(configDir: string): string {
  return join(configDir, 'skills');
}

/** Disabled skills are parked here — invisible to the runtime. */
export function getDisabledSkillsDir(configDir: string): string {
  return join(configDir, 'skills-disabled');
}

export function parseFrontmatter(content: string): SkillFrontmatter | null {
  if (!content.startsWith('---')) {
    return null;
  }
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return null;
  }
  const yamlBlock = content.slice(3, endIdx);

  let values: Record<string, unknown>;
  try {
    values = parseYaml(yamlBlock) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!values || typeof values !== 'object') {
    return null;
  }

  const name = typeof values.name === 'string' ? values.name.trim() : undefined;
  const description = typeof values.description === 'string' ? values.description.trim() : undefined;

  if (!name || !description) {
    return null;
  }

  return {
    name,
    description,
    version: typeof values.version === 'string' ? values.version : typeof values.version === 'number' ? String(values.version) : undefined,
    author: typeof values.author === 'string' ? values.author : undefined,
    license: typeof values.license === 'string' ? values.license : undefined,
    compatibility: typeof values.compatibility === 'string' ? values.compatibility : undefined,
  };
}

async function scanSkillsIn(dir: string, enabled: boolean, sourceMap: Record<string, SkillSource>): Promise<SkillEntry[]> {
  let dirs: string[];
  try {
    dirs = await readdir(dir);
  } catch {
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const dirName of dirs) {
    const dirPath = join(dir, dirName);
    const skillMdPath = join(dirPath, SKILL_FILENAME);
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const meta = parseFrontmatter(content);
      if (meta) {
        entries.push({
          name: meta.name,
          description: meta.description,
          path: dirPath,
          enabled,
          source: sourceMap[meta.name] ?? { kind: 'local' },
          version: meta.version,
          author: meta.author,
          license: meta.license,
          compatibility: meta.compatibility,
        });
      }
    } catch {
      // Skip dirs without a valid SKILL.md
    }
  }
  return entries;
}

export async function listSkills(configDir: string, store: SkillStore): Promise<SkillEntry[]> {
  const sourceMap = store.get('skillSources') ?? {};
  const active = await scanSkillsIn(getSkillsDir(configDir), true, sourceMap);
  const disabled = await scanSkillsIn(getDisabledSkillsDir(configDir), false, sourceMap);
  return [...active, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
}

export async function installSkillFromFile(
  configDir: string,
  filePath: string,
  store: SkillStore
): Promise<SkillEntry> {
  const skillsDir = getSkillsDir(configDir);
  await mkdir(skillsDir, { recursive: true });

  // Extract to a temp dir first, then move the top-level folder into skillsDir.
  // Expected layout inside the zip: <skill-name>/SKILL.md (+ other files).
  const tmpDir = await mkdtemp(join(tmpdir(), 'skill-'));
  try {
    await extract(filePath, { dir: tmpDir });
  } catch {
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error('Invalid .skill file: failed to extract archive');
  }

  const extracted = await readdir(tmpDir);
  const topDir = extracted[0];
  if (!topDir || extracted.length === 0) {
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error('Invalid .skill file: archive is empty');
  }

  // Move extracted skill folder into the skills directory
  const destDir = join(skillsDir, topDir);
  await rm(destDir, { recursive: true, force: true });
  await rename(join(tmpDir, topDir), destDir);
  await rm(tmpDir, { recursive: true, force: true });

  // Validate the extracted skill
  const dirPath = join(skillsDir, topDir);
  const skillMdPath = join(dirPath, SKILL_FILENAME);
  let content: string;
  try {
    content = await readFile(skillMdPath, 'utf-8');
  } catch {
    await rm(dirPath, { recursive: true, force: true });
    throw new Error('Invalid .skill file: no SKILL.md found in archive');
  }

  const meta = parseFrontmatter(content);
  if (!meta) {
    await rm(dirPath, { recursive: true, force: true });
    throw new Error('Invalid .skill file: SKILL.md has invalid or missing frontmatter');
  }

  // Persist source metadata
  const filename = filePath.split('/').pop() ?? filePath;
  const source: SkillSource = { kind: 'file', filename };
  const sources = store.get('skillSources') ?? {};
  store.set('skillSources', { ...sources, [meta.name]: source });

  return {
    name: meta.name,
    description: meta.description,
    path: dirPath,
    enabled: true,
    source,
    version: meta.version,
    author: meta.author,
    license: meta.license,
    compatibility: meta.compatibility,
  };
}

export async function uninstallSkill(configDir: string, name: string, store: SkillStore): Promise<void> {
  // Could be in either directory
  await rm(join(getSkillsDir(configDir), name), { recursive: true, force: true });
  await rm(join(getDisabledSkillsDir(configDir), name), { recursive: true, force: true });

  // Clean store source metadata
  const sources = store.get('skillSources') ?? {};
  const { [name]: _, ...rest } = sources;
  store.set('skillSources', rest);
}

export async function setSkillEnabled(configDir: string, name: string, enabled: boolean): Promise<void> {
  const fromDir = enabled ? getDisabledSkillsDir(configDir) : getSkillsDir(configDir);
  const toDir = enabled ? getSkillsDir(configDir) : getDisabledSkillsDir(configDir);
  const src = join(fromDir, name);
  const dest = join(toDir, name);

  await mkdir(toDir, { recursive: true });
  await rename(src, dest);
}
