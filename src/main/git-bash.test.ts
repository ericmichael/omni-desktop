import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  existing: new Set<string>(),
  runtimeDir: '/runtime',
}));

vi.mock('@/main/util', () => ({
  getOmniRuntimeDir: () => hoisted.runtimeDir,
  pathExists: (p: string) => Promise.resolve(hoisted.existing.has(p)),
}));

import { BASH_ENV_VAR, ensureGitBash, getGitBashEnv, getPortableGitDir } from '@/main/git-bash';

const log = { info: vi.fn(), warn: vi.fn() };
const realPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });

describe('git-bash provisioning', () => {
  beforeEach(() => {
    hoisted.existing.clear();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    vi.stubEnv('ProgramW6432', '');
    vi.stubEnv('ProgramFiles(x86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('OMNI_CI_FORCE_PORTABLE_GIT', '');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does nothing off Windows', async () => {
    setPlatform('linux');
    await expect(ensureGitBash(log, () => false)).resolves.toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
    expect(await getGitBashEnv()).toEqual({});
  });

  it('uses an installed Git for Windows instead of downloading', async () => {
    setPlatform('win32');
    hoisted.existing.add(path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'));
    await expect(ensureGitBash(log, () => false)).resolves.toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a download whose checksum does not match the pin', async () => {
    setPlatform('win32');
    vi.mocked(fetch).mockResolvedValue(new Response('not the real PortableGit'));
    await expect(ensureGitBash(log, () => false)).rejects.toThrow(/Could not install Git Bash.*checksum mismatch/);
  });

  it('points the runtime at the provisioned bash only when it exists', async () => {
    setPlatform('win32');
    expect(await getGitBashEnv()).toEqual({});
    const bash = path.join(getPortableGitDir(), 'bin', 'bash.exe');
    hoisted.existing.add(bash);
    expect(await getGitBashEnv()).toEqual({ [BASH_ENV_VAR]: bash });
  });
});
