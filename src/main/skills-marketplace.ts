import extract from 'extract-zip';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import type { SkillStore } from '@/main/skills';
import { getDisabledSkillsDir, getSkillsDir, parseFrontmatter } from '@/main/skills';
import type {
  BundleUpdateInfo,
  InstalledBundle,
  MarketplaceManifest,
  MarketplacePlugin,
  SkillEntry,
  SkillSource,
} from '@/shared/types';

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

/** Stable key for `StoreData.installedBundles`. */
export function bundleKey(repo: string, plugin: string): string {
  return `${repo}:${plugin}`;
}

/** Normalize "anthropics/skills" or a github URL into { owner, repo, ref }. */
export function parseRepoSpec(spec: string): RepoSpec {
  const trimmed = spec.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/);
  if (short) {
return { owner: short[1]!, repo: short[2]!, ref: short[3] ?? 'main' };
}
  const url = trimmed.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/);
  if (url) {
return { owner: url[1]!, repo: url[2]!, ref: url[3] ?? 'main' };
}
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
    if (raw !== undefined) {
break;
}
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
  if (!manifest.apps) {
return;
}
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

/**
 * Copy every skill in `plugin` from the unpacked repo into the active skills
 * directory, validate each SKILL.md, and return the resulting entries plus
 * the source map updates the caller should persist. Throws if any skill is
 * malformed (no partial-write rollback — caller decides whether to commit
 * the source-map mutation).
 */
async function copyPluginSkills(
  configDir: string,
  repoRoot: string,
  plugin: MarketplacePlugin,
  bundleSource: SkillSource & { kind: 'marketplace' }
): Promise<{ installed: SkillEntry[]; sourceUpdates: Record<string, SkillSource> }> {
  const skillsDir = getSkillsDir(configDir);
  await mkdir(skillsDir, { recursive: true });

  const installed: SkillEntry[] = [];
  const sourceUpdates: Record<string, SkillSource> = {};

  for (const relPath of plugin.skills) {
    const srcDir = join(repoRoot, plugin.source ?? '.', relPath);
    const skillMd = join(srcDir, SKILL_FILENAME);
    const content = await readFile(skillMd, 'utf-8').catch(() => '');
    const meta = parseFrontmatter(content);
    if (!meta) {
      throw new Error(`Skill at ${relPath} is missing or has invalid SKILL.md`);
    }

    const destDir = join(skillsDir, basename(srcDir));
    await rm(destDir, { recursive: true, force: true });
    await cp(srcDir, destDir, { recursive: true });

    sourceUpdates[meta.name] = bundleSource;
    installed.push({
      name: meta.name,
      description: meta.description,
      path: destDir,
      enabled: true,
      source: bundleSource,
      version: meta.version,
      author: meta.author,
      license: meta.license,
      compatibility: meta.compatibility,
    });
  }

  return { installed, sourceUpdates };
}

function recordBundle(store: SkillStore, bundle: InstalledBundle): void {
  const bundles = { ...(store.get('installedBundles') ?? {}) };
  bundles[bundleKey(bundle.repo, bundle.plugin)] = bundle;
  store.set('installedBundles', bundles);
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

    const bundleSource: SkillSource = {
      kind: 'marketplace',
      repo: repoSlug,
      plugin: pluginName,
      ref: repoSpec.ref,
    };

    const { installed, sourceUpdates } = await copyPluginSkills(
      configDir,
      root,
      plugin,
      bundleSource
    );

    const sources = { ...(store.get('skillSources') ?? {}), ...sourceUpdates };
    store.set('skillSources', sources);

    recordBundle(store, {
      repo: repoSlug,
      plugin: pluginName,
      ref: repoSpec.ref,
      version: manifest.metadata?.version,
      skillNames: installed.map((s) => s.name),
      installedAt: Date.now(),
    });

    return installed;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Re-fetch a previously installed bundle from upstream and reconcile:
 * - copy added/changed skills into the active skills directory,
 * - delete any skills the upstream no longer ships (only if their source
 *   still points at this bundle — never touch user-modified provenance),
 * - bump the stored bundle record.
 *
 * If the bundle isn't tracked in `installedBundles`, this falls back to a
 * fresh install so the action is idempotent from the UI's perspective.
 */
export async function updateMarketplacePlugin(
  configDir: string,
  spec: string,
  pluginName: string,
  store: SkillStore
): Promise<SkillEntry[]> {
  const repoSpec = parseRepoSpec(spec);
  const repoSlug = `${repoSpec.owner}/${repoSpec.repo}`;
  const key = bundleKey(repoSlug, pluginName);

  const root = await downloadRepo(repoSpec);
  try {
    const manifest = await readManifest(root);
    const plugin = manifest.plugins.find((p) => p.name === pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" not found in ${repoSlug}`);
    }

    const bundleSource: SkillSource = {
      kind: 'marketplace',
      repo: repoSlug,
      plugin: pluginName,
      ref: repoSpec.ref,
    };

    const { installed, sourceUpdates } = await copyPluginSkills(
      configDir,
      root,
      plugin,
      bundleSource
    );

    const liveNames = new Set(installed.map((s) => s.name));
    const previousBundle = (store.get('installedBundles') ?? {})[key];
    const previousNames = previousBundle?.skillNames ?? [];

    // Reap skills that were part of this bundle previously but are no longer
    // shipped upstream. Only touch skills whose source still claims this
    // bundle — if the user reinstalled them from elsewhere, leave them alone.
    const sources = { ...(store.get('skillSources') ?? {}), ...sourceUpdates };
    const skillsDir = getSkillsDir(configDir);
    const disabledDir = getDisabledSkillsDir(configDir);
    for (const name of previousNames) {
      if (liveNames.has(name)) {
continue;
}
      const src = sources[name];
      if (src?.kind === 'marketplace' && src.repo === repoSlug && src.plugin === pluginName) {
        await rm(join(skillsDir, name), { recursive: true, force: true });
        await rm(join(disabledDir, name), { recursive: true, force: true });
        delete sources[name];
      }
    }
    store.set('skillSources', sources);

    recordBundle(store, {
      repo: repoSlug,
      plugin: pluginName,
      ref: repoSpec.ref,
      version: manifest.metadata?.version,
      skillNames: installed.map((s) => s.name),
      installedAt: Date.now(),
    });

    return installed;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Probe upstream for every installed bundle and report whether any have
 * drifted from the on-disk record. Network failures are returned per-bundle
 * as `unreachable` so a partially-online check still surfaces the bundles
 * that did resolve.
 */
export async function checkBundleUpdates(store: SkillStore): Promise<BundleUpdateInfo[]> {
  const bundles = store.get('installedBundles') ?? {};
  const entries = Object.entries(bundles);

  // Fetch in parallel — the manifests are small and independent.
  const reports = await Promise.all(
    entries.map(async ([key, bundle]): Promise<BundleUpdateInfo> => {
      try {
        const manifest = await fetchMarketplace(`${bundle.repo}@${bundle.ref}`);
        const plugin = manifest.plugins.find((p) => p.name === bundle.plugin);
        if (!plugin) {
          return {
            bundleKey: key,
            repo: bundle.repo,
            plugin: bundle.plugin,
            status: 'unreachable',
            installedVersion: bundle.version,
            addedSkills: [],
            removedSkills: [],
            error: `Plugin "${bundle.plugin}" no longer present in ${bundle.repo}`,
          };
        }

        // We can't know the live skill names without copying SKILL.md files,
        // so derive them from the relative paths and trust the basename.
        // Anything that fails to match will just appear as "added" until the
        // user runs an actual update.
        const liveNames = plugin.skills.map((p) => basename(p));
        const installedNames = new Set(bundle.skillNames);
        const liveSet = new Set(liveNames);
        const addedSkills = liveNames.filter((n) => !installedNames.has(n));
        const removedSkills = bundle.skillNames.filter((n) => !liveSet.has(n));

        const liveVersion = manifest.metadata?.version;
        const versionChanged =
          liveVersion !== undefined && liveVersion !== bundle.version;
        const hasDiff = addedSkills.length > 0 || removedSkills.length > 0 || versionChanged;

        return {
          bundleKey: key,
          repo: bundle.repo,
          plugin: bundle.plugin,
          status: hasDiff ? 'update-available' : 'up-to-date',
          installedVersion: bundle.version,
          liveVersion,
          addedSkills,
          removedSkills,
        };
      } catch (e) {
        return {
          bundleKey: key,
          repo: bundle.repo,
          plugin: bundle.plugin,
          status: 'unreachable',
          installedVersion: bundle.version,
          addedSkills: [],
          removedSkills: [],
          error: e instanceof Error ? e.message : 'unknown error',
        };
      }
    })
  );

  return reports;
}
