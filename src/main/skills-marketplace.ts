import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import extract from 'extract-zip';

import { getSkillsDir, parseFrontmatter } from '@/main/skills';
import type { SkillStore } from '@/main/skills';
import type { MarketplaceManifest, SkillEntry, SkillSource } from '@/shared/types';

/**
 * Manifest is read from the first path that exists. `.omni-plugin/` is the
 * Omni-native location; `.claude-plugin/` is supported so existing Claude
 * Code plugin marketplaces (e.g. `anthropics/skills`) keep working.
 */
const MARKETPLACE_PATHS = [
  '.omni-plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
];
const SKILL_FILENAME = 'SKILL.md';

type RepoSpec = { owner: string; repo: string; ref: string };

/** Normalize "anthropics/skills" or a github URL into { owner, repo, ref }. */
export function parseRepoSpec(spec: string): RepoSpec {
  const trimmed = spec.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/);
  if (short) return { owner: short[1]!, repo: short[2]!, ref: short[3] ?? 'main' };
  const url = trimmed.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3] ?? 'main' };
  throw new Error(`Unsupported marketplace source: ${spec}`);
}

async function downloadRepo(spec: RepoSpec): Promise<string> {
  const { owner, repo, ref } = spec;
  const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${ref}`;
  const res = await fetch(zipUrl);
  if (!res.ok) {
    throw new Error(`Failed to download ${owner}/${repo}@${ref}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const work = await mkdtemp(join(tmpdir(), 'skills-mkt-'));
  const zipPath = join(work, 'repo.zip');
  await writeFile(zipPath, buf);
  await extract(zipPath, { dir: work });

  // GitHub zips extract to <repo>-<ref>/. Pick the first matching dir.
  const entries = await readdir(work);
  const top = entries.find((d) => d.startsWith(`${repo}-`));
  if (!top) {
    await rm(work, { recursive: true, force: true });
    throw new Error('Unexpected archive layout — no repo directory found');
  }
  return join(work, top);
}

async function readManifest(repoRoot: string): Promise<MarketplaceManifest> {
  let raw: string | undefined;
  for (const candidate of MARKETPLACE_PATHS) {
    raw = await readFile(join(repoRoot, candidate), 'utf-8').catch(() => undefined);
    if (raw !== undefined) break;
  }
  if (raw === undefined) {
    throw new Error(`Repo does not contain ${MARKETPLACE_PATHS.join(' or ')}`);
  }
  let parsed: MarketplaceManifest;
  try {
    parsed = JSON.parse(raw) as MarketplaceManifest;
  } catch (e) {
    throw new Error(`Invalid marketplace.json: ${e instanceof Error ? e.message : 'parse error'}`);
  }
  if (!parsed || !Array.isArray(parsed.plugins)) {
    throw new Error('Invalid marketplace.json: missing plugins[]');
  }
  return parsed;
}

/**
 * Resolve relative icon paths (e.g. `./apps/icons/spotify.svg`) in
 * marketplace apps to inline SVG content so the renderer can display
 * them without a second fetch.
 */
async function resolveAppIcons(manifest: MarketplaceManifest, repoRoot: string): Promise<void> {
  if (!manifest.apps) return;
  for (const app of manifest.apps) {
    if (app.icon && (app.icon.startsWith('./') || app.icon.startsWith('/'))) {
      const svgPath = join(repoRoot, app.icon);
      const svg = await readFile(svgPath, 'utf-8').catch(() => '');
      if (svg) {
        app.icon = svg;
      }
    }
  }
}

export async function fetchMarketplace(spec: string): Promise<MarketplaceManifest> {
  const repoSpec = parseRepoSpec(spec);
  const root = await downloadRepo(repoSpec);
  try {
    const manifest = await readManifest(root);
    await resolveAppIcons(manifest, root);
    return manifest;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installMarketplacePlugin(
  configDir: string,
  spec: string,
  pluginName: string,
  store: SkillStore
): Promise<SkillEntry[]> {
  const repoSpec = parseRepoSpec(spec);
  const repoSlug = `${repoSpec.owner}/${repoSpec.repo}`;
  const root = await downloadRepo(repoSpec);

  try {
    const manifest = await readManifest(root);
    const plugin = manifest.plugins.find((p) => p.name === pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" not found in ${repoSlug}`);
    }

    const skillsDir = getSkillsDir(configDir);
    await mkdir(skillsDir, { recursive: true });

    const sources = { ...(store.get('skillSources') ?? {}) };
    const installed: SkillEntry[] = [];

    for (const relPath of plugin.skills) {
      const srcDir = join(root, plugin.source ?? '.', relPath);
      const skillMd = join(srcDir, SKILL_FILENAME);
      const content = await readFile(skillMd, 'utf-8').catch(() => '');
      const meta = parseFrontmatter(content);
      if (!meta) {
        throw new Error(`Skill at ${relPath} is missing or has invalid SKILL.md`);
      }

      const destDir = join(skillsDir, basename(srcDir));
      await rm(destDir, { recursive: true, force: true });
      await cp(srcDir, destDir, { recursive: true });

      const source: SkillSource = {
        kind: 'marketplace',
        repo: repoSlug,
        plugin: pluginName,
        ref: repoSpec.ref,
      };
      sources[meta.name] = source;

      installed.push({
        name: meta.name,
        description: meta.description,
        path: destDir,
        enabled: true,
        source,
        version: meta.version,
        author: meta.author,
        license: meta.license,
        compatibility: meta.compatibility,
      });
    }

    store.set('skillSources', sources);
    return installed;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
