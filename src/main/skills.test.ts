/**
 * Tests for skills — SKILL.md frontmatter parsing, skill listing from
 * active + disabled directories, install from .skill zip, uninstall,
 * and enable/disable via directory move.
 */
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'fs';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import archiver from 'archiver';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getSkillsDir,
  installSkillFromFile,
  listSkills,
  parseFrontmatter,
  setSkillEnabled,
  uninstallSkill,
} from '@/main/skills';
import type { SkillStore } from '@/main/skills';
import type { StoreData } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let configDir: string;

function createMockStore(initial: Partial<StoreData> = {}): SkillStore {
  const data: Partial<StoreData> = {
    skillSources: {},
    ...initial,
  };
  return {
    get: <K extends keyof StoreData>(key: K) => data[key] as StoreData[K],
    set: <K extends keyof StoreData>(key: K, value: StoreData[K]) => {
      (data as Record<string, unknown>)[key] = value;
    },
  };
}

/** Create a .skill zip file from a skill name + SKILL.md content. */
async function createSkillZip(
  outputPath: string,
  skillName: string,
  skillMdContent: string,
  extraFiles?: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(skillMdContent, { name: `${skillName}/SKILL.md` });
    if (extraFiles) {
      for (const [path, content] of Object.entries(extraFiles)) {
        archive.append(content, { name: `${skillName}/${path}` });
      }
    }
    void archive.finalize();
  });
}

/** Create a skill directory directly on disk (simulates manual creation). */
async function createSkillOnDisk(
  configDir: string,
  name: string,
  frontmatter: string,
  disabled = false
): Promise<string> {
  const base = disabled ? join(configDir, 'skills-disabled') : getSkillsDir(configDir);
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), frontmatter);
  return dir;
}

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
  it('parses valid frontmatter with name and description', () => {
    const result = parseFrontmatter('---\nname: my-skill\ndescription: Does things\n---\n\nBody');
    expect(result).toEqual({ name: 'my-skill', description: 'Does things' });
  });

  it('parses optional fields (version, author, license, compatibility)', () => {
    const content = [
      '---',
      'name: my-skill',
      'description: Does things',
      'version: 1.2.3',
      'author: Jane Doe',
      'license: MIT',
      'compatibility: Requires Python 3.10+',
      '---',
      '',
    ].join('\n');
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: 'my-skill',
      description: 'Does things',
      version: '1.2.3',
      author: 'Jane Doe',
      license: 'MIT',
      compatibility: 'Requires Python 3.10+',
    });
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

  it('leaves optional fields undefined when not present', () => {
    const result = parseFrontmatter('---\nname: test\ndescription: ok\n---\n');
    expect(result).toEqual({ name: 'test', description: 'ok' });
    expect(result!.version).toBeUndefined();
    expect(result!.author).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe('listSkills', () => {
  it('returns empty array when skills dir does not exist', async () => {
    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result).toEqual([]);
  });

  it('returns empty array when skills dir is empty', async () => {
    await mkdir(join(configDir, 'skills'), { recursive: true });
    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result).toEqual([]);
  });

  it('returns active skills with enabled=true', async () => {
    await createSkillOnDisk(configDir, 'my-skill', '---\nname: my-skill\ndescription: A skill\n---\n');

    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'my-skill',
      description: 'A skill',
      enabled: true,
      source: { kind: 'local' },
    });
  });

  it('returns disabled skills with enabled=false', async () => {
    await createSkillOnDisk(configDir, 'off-skill', '---\nname: off-skill\ndescription: Disabled\n---\n', true);

    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result).toHaveLength(1);
    expect(result[0]!.enabled).toBe(false);
  });

  it('merges active and disabled skills sorted by name', async () => {
    await createSkillOnDisk(configDir, 'zulu', '---\nname: zulu\ndescription: Z\n---\n');
    await createSkillOnDisk(configDir, 'alpha', '---\nname: alpha\ndescription: A\n---\n', true);
    await createSkillOnDisk(configDir, 'mike', '---\nname: mike\ndescription: M\n---\n');

    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result.map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu']);
    expect(result.map((s) => s.enabled)).toEqual([false, true, true]);
  });

  it('respects skillSources from store', async () => {
    await createSkillOnDisk(configDir, 'installed', '---\nname: installed\ndescription: From file\n---\n');

    const store = createMockStore({
      skillSources: { installed: { kind: 'file', filename: 'installed.skill' } },
    });
    const result = await listSkills(configDir, store);
    expect(result[0]!.source).toEqual({ kind: 'file', filename: 'installed.skill' });
  });

  it('skips dirs without SKILL.md', async () => {
    await mkdir(join(configDir, 'skills', 'empty-dir'), { recursive: true });
    const store = createMockStore();
    const result = await listSkills(configDir, store);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setSkillEnabled (directory move)
// ---------------------------------------------------------------------------

describe('setSkillEnabled', () => {
  it('disabling moves skill from skills/ to skills-disabled/', async () => {
    await createSkillOnDisk(configDir, 'toggleable', '---\nname: toggleable\ndescription: Toggle\n---\n');

    await setSkillEnabled(configDir, 'toggleable', false);

    expect(existsSync(join(configDir, 'skills', 'toggleable'))).toBe(false);
    expect(existsSync(join(configDir, 'skills-disabled', 'toggleable', 'SKILL.md'))).toBe(true);
  });

  it('enabling moves skill from skills-disabled/ to skills/', async () => {
    await createSkillOnDisk(configDir, 'toggleable', '---\nname: toggleable\ndescription: Toggle\n---\n', true);

    await setSkillEnabled(configDir, 'toggleable', true);

    expect(existsSync(join(configDir, 'skills-disabled', 'toggleable'))).toBe(false);
    expect(existsSync(join(configDir, 'skills', 'toggleable', 'SKILL.md'))).toBe(true);
  });

  it('round-trips through listSkills', async () => {
    await createSkillOnDisk(configDir, 'rt', '---\nname: rt\ndescription: Round trip\n---\n');
    const store = createMockStore();

    let list = await listSkills(configDir, store);
    expect(list[0]!.enabled).toBe(true);

    await setSkillEnabled(configDir, 'rt', false);
    list = await listSkills(configDir, store);
    expect(list[0]!.enabled).toBe(false);

    await setSkillEnabled(configDir, 'rt', true);
    list = await listSkills(configDir, store);
    expect(list[0]!.enabled).toBe(true);
  });

  it('disabled skills are invisible to the runtime skills dir', async () => {
    await createSkillOnDisk(configDir, 'hidden', '---\nname: hidden\ndescription: Gone\n---\n');
    await setSkillEnabled(configDir, 'hidden', false);

    const activeDir = getSkillsDir(configDir);
    let entries: string[];
    try {
      entries = await readdir(activeDir);
    } catch {
      entries = [];
    }
    expect(entries).not.toContain('hidden');
  });
});

// ---------------------------------------------------------------------------
// installSkillFromFile
// ---------------------------------------------------------------------------

describe('installSkillFromFile', () => {
  it('installs a valid .skill zip and returns SkillEntry', async () => {
    const zipPath = join(configDir, 'test.skill');
    await createSkillZip(zipPath, 'test-skill', '---\nname: test-skill\ndescription: A test\nversion: 1.0\n---\n\nBody');

    const store = createMockStore();
    const entry = await installSkillFromFile(configDir, zipPath, store);

    expect(entry.name).toBe('test-skill');
    expect(entry.description).toBe('A test');
    expect(entry.version).toBe('1.0');
    expect(entry.enabled).toBe(true);
    expect(entry.source).toEqual({ kind: 'file', filename: 'test.skill' });
    expect(existsSync(join(configDir, 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });

  it('persists source metadata in store', async () => {
    const zipPath = join(configDir, 'persisted.skill');
    await createSkillZip(zipPath, 'persisted', '---\nname: persisted\ndescription: Test\n---\n');

    const store = createMockStore();
    await installSkillFromFile(configDir, zipPath, store);

    expect(store.get('skillSources')).toEqual({ persisted: { kind: 'file', filename: 'persisted.skill' } });
  });

  it('extracts additional files from the zip', async () => {
    const zipPath = join(configDir, 'multi.skill');
    await createSkillZip(zipPath, 'multi', '---\nname: multi\ndescription: Multi-file\n---\n', {
      'scripts/helper.py': '# helper',
      'references/guide.md': '# Guide',
    });

    const store = createMockStore();
    await installSkillFromFile(configDir, zipPath, store);

    expect(existsSync(join(configDir, 'skills', 'multi', 'scripts', 'helper.py'))).toBe(true);
    expect(existsSync(join(configDir, 'skills', 'multi', 'references', 'guide.md'))).toBe(true);
  });

  it('throws on nonexistent file', async () => {
    const store = createMockStore();
    await expect(installSkillFromFile(configDir, join(configDir, 'nonexistent.skill'), store)).rejects.toThrow();
  });

  it('throws and cleans up when SKILL.md is missing', async () => {
    const zipPath = join(configDir, 'no-skill-md.skill');
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append('not a skill', { name: 'bad-skill/readme.txt' });
      void archive.finalize();
    });

    const store = createMockStore();
    await expect(installSkillFromFile(configDir, zipPath, store)).rejects.toThrow('no SKILL.md found');
    expect(existsSync(join(configDir, 'skills', 'bad-skill'))).toBe(false);
  });

  it('throws and cleans up when frontmatter is invalid', async () => {
    const zipPath = join(configDir, 'bad-fm.skill');
    await createSkillZip(zipPath, 'bad-fm', 'no frontmatter here');

    const store = createMockStore();
    await expect(installSkillFromFile(configDir, zipPath, store)).rejects.toThrow('invalid or missing frontmatter');
    expect(existsSync(join(configDir, 'skills', 'bad-fm'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// uninstallSkill
// ---------------------------------------------------------------------------

describe('uninstallSkill', () => {
  it('removes an active skill and cleans store', async () => {
    const zipPath = join(configDir, 'removable.skill');
    await createSkillZip(zipPath, 'removable', '---\nname: removable\ndescription: Bye\n---\n');

    const store = createMockStore();
    await installSkillFromFile(configDir, zipPath, store);
    expect(existsSync(join(configDir, 'skills', 'removable'))).toBe(true);

    await uninstallSkill(configDir, 'removable', store);
    expect(existsSync(join(configDir, 'skills', 'removable'))).toBe(false);
    expect(store.get('skillSources')).toEqual({});
  });

  it('removes a disabled skill', async () => {
    await createSkillOnDisk(configDir, 'disabled-rm', '---\nname: disabled-rm\ndescription: Off\n---\n', true);
    const store = createMockStore();

    await uninstallSkill(configDir, 'disabled-rm', store);
    expect(existsSync(join(configDir, 'skills-disabled', 'disabled-rm'))).toBe(false);
  });

  it('does not throw for nonexistent skill', async () => {
    const store = createMockStore();
    await expect(uninstallSkill(configDir, 'ghost', store)).resolves.toBeUndefined();
  });
});
