import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import archiver from 'archiver';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchMarketplace,
  installMarketplacePlugin,
  parseRepoSpec,
} from '@/main/skills-marketplace';
import type { SkillStore } from '@/main/skills';
import type { MarketplaceManifest, StoreData } from '@/shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;
let configDir: string;

const REPO_OWNER = 'anthropics';
const REPO_NAME = 'skills';
const REPO_REF = 'main';
const REPO_SPEC = `${REPO_OWNER}/${REPO_NAME}`;

function createMockStore(initial: Partial<StoreData> = {}): SkillStore {
  const data: Partial<StoreData> = { skillSources: {}, ...initial };
  return {
    get: <K extends keyof StoreData>(key: K) => data[key] as StoreData[K],
    set: <K extends keyof StoreData>(key: K, value: StoreData[K]) => {
      (data as Record<string, unknown>)[key] = value;
    },
  };
}

/** Build a github-style repo zip: top-level dir is `<repo>-<ref>/`. */
async function buildRepoZip(
  outputPath: string,
  files: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    const topDir = `${REPO_NAME}-${REPO_REF}`;
    for (const [path, content] of Object.entries(files)) {
      archive.append(content, { name: `${topDir}/${path}` });
    }
    void archive.finalize();
  });
}

const VALID_MARKETPLACE: MarketplaceManifest = {
  name: 'test-marketplace',
  metadata: { description: 'fixture', version: '1.0.0' },
  plugins: [
    {
      name: 'document-skills',
      description: 'PDF and Word skills',
      source: './',
      strict: false,
      skills: ['./skills/pdf', './skills/docx'],
    },
    {
      name: 'creative-skills',
      description: 'Just one skill',
      source: './',
      skills: ['./skills/canvas-design'],
    },
  ],
};

const SKILL_PDF = '---\nname: pdf\ndescription: PDF tools\nversion: 2.0.0\nlicense: Proprietary\n---\n\nBody';
const SKILL_DOCX = '---\nname: docx\ndescription: DOCX tools\n---\n\nBody';
const SKILL_CANVAS = '---\nname: canvas-design\ndescription: Canvas art\n---\n\nBody';

/** Stub fetch so any codeload URL returns the bytes of `zipPath`. */
function stubFetchToZip(zipPath: string): void {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.includes('codeload.github.com')) {
      return new Response('not found', { status: 404 });
    }
    const body = readFileSync(zipPath);
    return new Response(body, { status: 200 });
  });
}

function stubFetchToError(status: number): void {
  vi.stubGlobal('fetch', async () => new Response('boom', { status }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mkt-test-'));
  configDir = mkdtempSync(join(tmpdir(), 'mkt-cfg-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseRepoSpec
// ---------------------------------------------------------------------------

describe('parseRepoSpec', () => {
  it('parses owner/repo shorthand with default ref main', () => {
    expect(parseRepoSpec('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
    });
  });

  it('parses owner/repo@ref shorthand', () => {
    expect(parseRepoSpec('anthropics/skills@v1.0.0')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'v1.0.0',
    });
  });

  it('parses a github URL', () => {
    expect(parseRepoSpec('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
    });
  });

  it('parses a github URL with /tree/<ref>', () => {
    expect(parseRepoSpec('https://github.com/anthropics/skills/tree/develop')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'develop',
    });
  });

  it('strips a trailing .git', () => {
    expect(parseRepoSpec('https://github.com/anthropics/skills.git')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
    });
  });

  it('strips trailing slashes', () => {
    expect(parseRepoSpec('anthropics/skills/')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
    });
  });

  it('throws on unsupported sources', () => {
    expect(() => parseRepoSpec('https://gitlab.com/foo/bar')).toThrow(/Unsupported/);
    expect(() => parseRepoSpec('not a repo')).toThrow(/Unsupported/);
    expect(() => parseRepoSpec('')).toThrow(/Unsupported/);
  });
});

// ---------------------------------------------------------------------------
// fetchMarketplace
// ---------------------------------------------------------------------------

describe('fetchMarketplace', () => {
  it('downloads a zip, parses marketplace.json, returns the manifest', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.claude-plugin/marketplace.json': JSON.stringify(VALID_MARKETPLACE),
    });
    stubFetchToZip(zipPath);

    const manifest = await fetchMarketplace(REPO_SPEC);
    expect(manifest.name).toBe('test-marketplace');
    expect(manifest.plugins).toHaveLength(2);
    expect(manifest.plugins[0]!.name).toBe('document-skills');
  });

  it('throws when the http request fails', async () => {
    stubFetchToError(404);
    await expect(fetchMarketplace(REPO_SPEC)).rejects.toThrow(/HTTP 404/);
  });

  it('throws when the repo has no marketplace.json', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, { 'README.md': 'nothing here' });
    stubFetchToZip(zipPath);
    await expect(fetchMarketplace(REPO_SPEC)).rejects.toThrow(/marketplace\.json/);
  });

  it('reads marketplace.json from .omni-plugin/', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.omni-plugin/marketplace.json': JSON.stringify({ ...VALID_MARKETPLACE, name: 'omni' }),
    });
    stubFetchToZip(zipPath);
    const manifest = await fetchMarketplace(REPO_SPEC);
    expect(manifest.name).toBe('omni');
  });

  it('prefers .omni-plugin/ over .claude-plugin/ when both exist', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.omni-plugin/marketplace.json': JSON.stringify({ ...VALID_MARKETPLACE, name: 'from-omni' }),
      '.claude-plugin/marketplace.json': JSON.stringify({ ...VALID_MARKETPLACE, name: 'from-claude' }),
    });
    stubFetchToZip(zipPath);
    const manifest = await fetchMarketplace(REPO_SPEC);
    expect(manifest.name).toBe('from-omni');
  });

  it('throws when marketplace.json is malformed JSON', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, { '.claude-plugin/marketplace.json': '{ not json' });
    stubFetchToZip(zipPath);
    await expect(fetchMarketplace(REPO_SPEC)).rejects.toThrow(/Invalid marketplace\.json/);
  });

  it('throws when marketplace.json is missing plugins[]', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'x' }),
    });
    stubFetchToZip(zipPath);
    await expect(fetchMarketplace(REPO_SPEC)).rejects.toThrow(/missing plugins/);
  });
});

// ---------------------------------------------------------------------------
// installMarketplacePlugin
// ---------------------------------------------------------------------------

describe('installMarketplacePlugin', () => {
  async function buildValidRepo(): Promise<string> {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.claude-plugin/marketplace.json': JSON.stringify(VALID_MARKETPLACE),
      'skills/pdf/SKILL.md': SKILL_PDF,
      'skills/pdf/scripts/run.py': 'print("hi")',
      'skills/docx/SKILL.md': SKILL_DOCX,
      'skills/canvas-design/SKILL.md': SKILL_CANVAS,
    });
    return zipPath;
  }

  it('copies all skills in a plugin into the skills dir and records source metadata', async () => {
    const zipPath = await buildValidRepo();
    stubFetchToZip(zipPath);
    const store = createMockStore();

    const installed = await installMarketplacePlugin(configDir, REPO_SPEC, 'document-skills', store);

    expect(installed.map((s) => s.name).sort()).toEqual(['docx', 'pdf']);

    // Source metadata persisted with full provenance
    const sources = store.get('skillSources');
    expect(sources['pdf']).toEqual({
      kind: 'marketplace',
      repo: 'anthropics/skills',
      plugin: 'document-skills',
      ref: 'main',
    });
    expect(sources['docx']).toEqual({
      kind: 'marketplace',
      repo: 'anthropics/skills',
      plugin: 'document-skills',
      ref: 'main',
    });

    // Files copied to disk, including non-SKILL.md children
    const pdfBody = await readFile(join(configDir, 'skills', 'pdf', 'SKILL.md'), 'utf-8');
    expect(pdfBody).toContain('PDF tools');
    const pdfScript = await readFile(join(configDir, 'skills', 'pdf', 'scripts', 'run.py'), 'utf-8');
    expect(pdfScript).toBe('print("hi")');

    // Optional frontmatter fields surface on returned entries
    const pdfEntry = installed.find((s) => s.name === 'pdf');
    expect(pdfEntry?.version).toBe('2.0.0');
    expect(pdfEntry?.license).toBe('Proprietary');
  });

  it('installs a plugin with a single skill', async () => {
    const zipPath = await buildValidRepo();
    stubFetchToZip(zipPath);
    const store = createMockStore();

    const installed = await installMarketplacePlugin(configDir, REPO_SPEC, 'creative-skills', store);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.name).toBe('canvas-design');
  });

  it('is idempotent — re-installing overwrites existing files', async () => {
    const zipPath = await buildValidRepo();
    stubFetchToZip(zipPath);
    const store = createMockStore();

    await installMarketplacePlugin(configDir, REPO_SPEC, 'creative-skills', store);
    // Mutate the on-disk skill so we can prove it was overwritten
    const skillMd = join(configDir, 'skills', 'canvas-design', 'SKILL.md');
    await (await import('fs/promises')).writeFile(skillMd, 'tampered');

    await installMarketplacePlugin(configDir, REPO_SPEC, 'creative-skills', store);
    const after = await readFile(skillMd, 'utf-8');
    expect(after).toContain('Canvas art');
  });

  it('preserves source metadata for skills from other plugins', async () => {
    const zipPath = await buildValidRepo();
    stubFetchToZip(zipPath);
    const store = createMockStore({
      skillSources: { 'unrelated-skill': { kind: 'file', filename: 'unrelated.skill' } },
    });

    await installMarketplacePlugin(configDir, REPO_SPEC, 'creative-skills', store);
    const sources = store.get('skillSources');
    expect(sources['unrelated-skill']).toEqual({ kind: 'file', filename: 'unrelated.skill' });
    expect(sources['canvas-design']?.kind).toBe('marketplace');
  });

  it('throws when the named plugin is not in the manifest', async () => {
    const zipPath = await buildValidRepo();
    stubFetchToZip(zipPath);
    const store = createMockStore();

    await expect(
      installMarketplacePlugin(configDir, REPO_SPEC, 'nonexistent', store)
    ).rejects.toThrow(/not found/);
  });

  it('throws when a listed skill has no SKILL.md', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'm',
        plugins: [{ name: 'broken', description: 'x', source: './', skills: ['./skills/missing'] }],
      }),
    });
    stubFetchToZip(zipPath);

    await expect(
      installMarketplacePlugin(configDir, REPO_SPEC, 'broken', createMockStore())
    ).rejects.toThrow(/missing or has invalid SKILL\.md/);
  });

  it('throws when a listed skill has malformed frontmatter', async () => {
    const zipPath = join(tmpRoot, 'repo.zip');
    await buildRepoZip(zipPath, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'm',
        plugins: [{ name: 'broken', description: 'x', source: './', skills: ['./skills/bad'] }],
      }),
      'skills/bad/SKILL.md': '# no frontmatter here',
    });
    stubFetchToZip(zipPath);

    await expect(
      installMarketplacePlugin(configDir, REPO_SPEC, 'broken', createMockStore())
    ).rejects.toThrow(/missing or has invalid SKILL\.md/);
  });
});
