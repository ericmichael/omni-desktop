import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { SkillEntry } from '@/shared/types';

const SKILL_FILENAME = 'SKILL.md';

function getSkillsDir(configDir: string): string {
  return join(configDir, 'skills');
}

export function parseFrontmatter(content: string): { name: string; description: string } | null {
  if (!content.startsWith('---')) {
return null;
}
  const parts = content.split('---', 3);
  if (parts.length < 3) {
return null;
}

  const lines = parts[1]!.trim().split('\n');
  let name = '';
  let description = '';
  for (const line of lines) {
    const match = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (!match) {
continue;
}
    const key = match[1];
    const value = match[2] ?? '';
    if (key === 'name') {
name = value.trim().replace(/^["']|["']$/g, '');
}
    if (key === 'description') {
description = value.trim().replace(/^["']|["']$/g, '');
}
  }

  if (!name || !description) {
return null;
}
  return { name, description };
}

export async function listSkills(configDir: string): Promise<SkillEntry[]> {
  const skillsDir = getSkillsDir(configDir);
  const entries: SkillEntry[] = [];

  let dirs: string[];
  try {
    dirs = await readdir(skillsDir);
  } catch {
    return entries;
  }

  for (const dirName of dirs) {
    const dirPath = join(skillsDir, dirName);
    const skillMdPath = join(dirPath, SKILL_FILENAME);
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const meta = parseFrontmatter(content);
      if (meta) {
        entries.push({
          name: meta.name,
          description: meta.description,
          path: dirPath,
          isGlobal: true,
        });
      }
    } catch {
      // Skip dirs without a valid SKILL.md
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillContent(skillPath: string): Promise<string | null> {
  try {
    return await readFile(join(skillPath, SKILL_FILENAME), 'utf-8');
  } catch {
    return null;
  }
}

export async function createSkill(
  configDir: string,
  name: string,
  description: string
): Promise<SkillEntry> {
  const skillsDir = getSkillsDir(configDir);
  const dirPath = join(skillsDir, name);
  await mkdir(dirPath, { recursive: true });

  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
  await writeFile(join(dirPath, SKILL_FILENAME), content, 'utf-8');

  return { name, description, path: dirPath, isGlobal: true };
}

export async function removeSkill(skillPath: string): Promise<void> {
  await rm(skillPath, { recursive: true, force: true });
}

export async function writeSkillContent(skillPath: string, content: string): Promise<void> {
  await writeFile(join(skillPath, SKILL_FILENAME), content, 'utf-8');
}
