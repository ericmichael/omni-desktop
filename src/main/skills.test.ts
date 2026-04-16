/**
 * Tests for skills — SKILL.md frontmatter parsing, skill CRUD with real
 * filesystem operations on temp directories.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSkill,
  listSkills,
  parseFrontmatter,
  readSkillContent,
  removeSkill,
  writeSkillContent,
} from '@/main/skills';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const result = parseFrontmatter('---\nname: my-skill\ndescription: Does things\n---\n\nBody');
    expect(result).toEqual({ name: 'my-skill', description: 'Does things' });
  });

  it('strips surrounding quotes from values', () => {
    const result = parseFrontmatter('---\nname: "quoted-name"\ndescription: \'quoted desc\'\n---\n');
    expect(result).toEqual({ name: 'quoted-name', description: 'quoted desc' });
  });

  it('returns null when content does not start with ---', () => {
    expect(parseFrontmatter('name: test\ndescription: test')).toBeNull();
  });

  it('returns null when there is no closing ---', () => {
    expect(parseFrontmatter('---\nname: test\ndescription: test')).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(parseFrontmatter('---\ndescription: test\n---\n')).toBeNull();
  });

  it('returns null when description is missing', () => {
    expect(parseFrontmatter('---\nname: test\n---\n')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseFrontmatter('')).toBeNull();
  });

  it('ignores lines that do not match key: value pattern', () => {
    const result = parseFrontmatter('---\nname: test\n  indented: no\ndescription: ok\n---\n');
    expect(result).toEqual({ name: 'test', description: 'ok' });
  });

  it('handles keys with hyphens', () => {
    // Keys with hyphens match the regex `\w[\w-]*`
    const result = parseFrontmatter('---\nname: my-skill\nmy-key: val\ndescription: desc\n---\n');
    expect(result).toEqual({ name: 'my-skill', description: 'desc' });
  });
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe('listSkills', () => {
  it('returns empty array when skills dir does not exist', async () => {
    const result = await listSkills(configDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when skills dir is empty', async () => {
    await mkdir(join(configDir, 'skills'), { recursive: true });
    const result = await listSkills(configDir);
    expect(result).toEqual([]);
  });

  it('returns valid skills and skips dirs without SKILL.md', async () => {
    const skillsDir = join(configDir, 'skills');
    // Valid skill
    const validDir = join(skillsDir, 'my-skill');
    await mkdir(validDir, { recursive: true });
    await writeFile(join(validDir, 'SKILL.md'), '---\nname: my-skill\ndescription: A skill\n---\n');
    // Dir without SKILL.md
    const emptyDir = join(skillsDir, 'no-skill');
    await mkdir(emptyDir, { recursive: true });

    const result = await listSkills(configDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'my-skill', description: 'A skill', isGlobal: true });
    expect(result[0]!.path).toBe(validDir);
  });

  it('skips dirs with broken frontmatter', async () => {
    const skillsDir = join(configDir, 'skills');
    const brokenDir = join(skillsDir, 'broken');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, 'SKILL.md'), 'no frontmatter here');

    const result = await listSkills(configDir);
    expect(result).toEqual([]);
  });

  it('returns skills sorted by name', async () => {
    const skillsDir = join(configDir, 'skills');
    for (const name of ['zulu', 'alpha', 'mike']) {
      const dir = join(skillsDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Desc\n---\n`);
    }

    const result = await listSkills(configDir);
    expect(result.map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu']);
  });
});

// ---------------------------------------------------------------------------
// createSkill + round-trip
// ---------------------------------------------------------------------------

describe('createSkill', () => {
  it('creates a skill directory with SKILL.md and returns SkillEntry', async () => {
    const entry = await createSkill(configDir, 'new-skill', 'A new skill');
    expect(entry).toMatchObject({
      name: 'new-skill',
      description: 'A new skill',
      isGlobal: true,
    });
    expect(existsSync(join(entry.path, 'SKILL.md'))).toBe(true);
  });

  it('round-trips through listSkills', async () => {
    await createSkill(configDir, 'round-trip', 'Tests round-trip');
    const skills = await listSkills(configDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'round-trip', description: 'Tests round-trip' });
  });
});

// ---------------------------------------------------------------------------
// readSkillContent
// ---------------------------------------------------------------------------

describe('readSkillContent', () => {
  it('reads SKILL.md content', async () => {
    const entry = await createSkill(configDir, 'readable', 'A readable skill');
    const content = await readSkillContent(entry.path);
    expect(content).toContain('name: readable');
    expect(content).toContain('description: A readable skill');
  });

  it('returns null for nonexistent skill path', async () => {
    const content = await readSkillContent(join(configDir, 'nonexistent'));
    expect(content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeSkillContent
// ---------------------------------------------------------------------------

describe('writeSkillContent', () => {
  it('overwrites SKILL.md content', async () => {
    const entry = await createSkill(configDir, 'writable', 'Original');
    const newContent = '---\nname: writable\ndescription: Updated\n---\n\nNew body';
    await writeSkillContent(entry.path, newContent);

    const read = readFileSync(join(entry.path, 'SKILL.md'), 'utf-8');
    expect(read).toBe(newContent);
  });
});

// ---------------------------------------------------------------------------
// removeSkill
// ---------------------------------------------------------------------------

describe('removeSkill', () => {
  it('deletes the skill directory', async () => {
    const entry = await createSkill(configDir, 'removable', 'To be removed');
    expect(existsSync(entry.path)).toBe(true);

    await removeSkill(entry.path);
    expect(existsSync(entry.path)).toBe(false);
  });

  it('does not throw for nonexistent path', async () => {
    await expect(removeSkill(join(configDir, 'ghost'))).resolves.toBeUndefined();
  });
});
