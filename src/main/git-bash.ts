/**
 * Git Bash for native Windows host mode.
 *
 * The agent's shell tool, background jobs, and framework plumbing speak
 * bash. On Windows the runtime (omniagents) runs host commands through Git
 * for Windows' bash — never cmd.exe — and finds it via `OMNIAGENTS_BASH` or an
 * installed Git for Windows (omniagents/workspace/host_shell.py).
 *
 * Students rarely have Git installed, so the runtime install provisions a
 * pinned PortableGit into the runtime dir: per-user, no admin, no registry or
 * PATH changes — the same model as the managed Python/uv. An existing Git for
 * Windows install is used instead when present.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getOmniRuntimeDir, pathExists } from '@/main/util';

/** Pinned PortableGit. Bump together: version, url, sha256 (from the release's asset digest). */
export const PORTABLE_GIT = {
  version: '2.56.0.windows.2',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe',
  sha256: '075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b',
  /** Extracted size is ~410 MB; the install preflight adds this headroom on Windows. */
  extractedBytes: 450 * 1024 * 1024,
} as const;

/** Environment variable omniagents reads for an explicit bash.exe. */
export const BASH_ENV_VAR = 'OMNIAGENTS_BASH';

/** CI-only: ignore an installed Git for Windows so the provisioning path is exercised. */
const FORCE_PORTABLE_ENV_VAR = 'OMNI_CI_FORCE_PORTABLE_GIT';

export const getPortableGitDir = (): string => path.join(getOmniRuntimeDir(), 'git');

const portableBashPath = (): string => path.join(getPortableGitDir(), 'bin', 'bash.exe');

/** Standard Git for Windows install locations (machine-wide and per-user). */
const systemGitBashCandidates = (): string[] => {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramW6432'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'),
  ].filter((value): value is string => Boolean(value));
  return roots.map((root) => path.join(root, 'Git', 'bin', 'bash.exe'));
};

const findSystemGitBash = async (): Promise<string | null> => {
  if (process.env[FORCE_PORTABLE_ENV_VAR]) {
    return null;
  }
  for (const candidate of systemGitBashCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Env for spawning the runtime on Windows: point omniagents at the
 * provisioned bash when we own one. An installed Git for Windows needs
 * nothing — omniagents finds it itself.
 */
export const getGitBashEnv = async (): Promise<Record<string, string>> => {
  if (process.platform !== 'win32') {
    return {};
  }
  const bash = portableBashPath();
  return (await pathExists(bash)) ? { [BASH_ENV_VAR]: bash } : {};
};

type Log = { info: (message: string) => void; warn: (message: string) => void };

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

const run = (command: string, args: string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });

/**
 * Make Git Bash available for native Windows host mode. No-op elsewhere, when
 * an installed Git for Windows exists, or when the pinned PortableGit is
 * already provisioned. Throws with an actionable message on failure.
 */
export const ensureGitBash = async (log: Log, isCanceled: () => boolean): Promise<'ready' | 'canceled'> => {
  if (process.platform !== 'win32') {
    return 'ready';
  }
  const system = await findSystemGitBash();
  if (system) {
    log.info(`Git Bash: using installed Git for Windows (${system})\r\n`);
    return 'ready';
  }
  const dir = getPortableGitDir();
  const marker = path.join(dir, '.omni-portable-git-version');
  const bash = portableBashPath();
  if ((await pathExists(bash)) && (await fs.readFile(marker, 'utf8').catch(() => '')) === PORTABLE_GIT.version) {
    log.info(`Git Bash: ready (${bash})\r\n`);
    return 'ready';
  }

  log.info(`Installing Git Bash (Git for Windows ${PORTABLE_GIT.version})...\r\n`);
  const download = path.join(os.tmpdir(), `omni-portable-git-${process.pid}.7z.exe`);
  try {
    const response = await fetch(PORTABLE_GIT.url);
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(download));
    if (isCanceled()) {
      return 'canceled';
    }
    const digest = await sha256File(download);
    if (digest !== PORTABLE_GIT.sha256) {
      throw new Error(`checksum mismatch (got ${digest}, expected ${PORTABLE_GIT.sha256})`);
    }

    // Replace any partial or older copy wholesale.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    // 7-Zip self-extractor: -o<dir> target, -y no prompts.
    const extracted = await run(download, [`-o${dir}`, '-y'], dir);
    if (extracted !== 0 || !(await pathExists(bash))) {
      throw new Error(`extraction failed (exit ${extracted})`);
    }
    // PortableGit finishes setup (/etc post-install scripts) on first run and
    // deletes the script afterwards; run it now rather than on a student's
    // first agent command.
    const postInstall = path.join(dir, 'post-install.bat');
    if (await pathExists(postInstall)) {
      const code = await run(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', 'post-install.bat'], dir);
      if (code !== 0) {
        log.warn(`Git Bash post-install exited ${code}; continuing\r\n`);
      }
    }
    await fs.writeFile(marker, PORTABLE_GIT.version, 'utf8');
    log.info(`Git Bash: installed (${bash})\r\n`);
    return 'ready';
  } catch (error) {
    throw new Error(
      `Could not install Git Bash, which the agent needs to run commands on Windows: ${(error as Error).message}. ` +
        'Check your internet connection and retry, or install Git for Windows (https://gitforwindows.org).'
    );
  } finally {
    await fs.rm(download, { force: true });
  }
};
