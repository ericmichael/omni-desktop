import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

const SEED_AUTHOR_NAME = 'Omni Seed';
const SEED_AUTHOR_EMAIL = 'seed@omni.local';

async function git(cwd, args) {
  return pexec('git', args, { cwd });
}

/** Initialize a repo with local user config set to the synthetic seed author. */
export async function gitInit(cwd) {
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', SEED_AUTHOR_NAME]);
  await git(cwd, ['config', 'user.email', SEED_AUTHOR_EMAIL]);
  await git(cwd, ['config', 'commit.gpgsign', 'false']);
}

export async function gitAddAll(cwd) {
  await git(cwd, ['add', '-A']);
}

export async function gitCommit(cwd, message) {
  await git(cwd, ['commit', '-m', message, '--allow-empty']);
}

export async function gitCheckoutBranch(cwd, branch) {
  await git(cwd, ['checkout', '-b', branch]);
}

export async function gitCheckout(cwd, branch) {
  await git(cwd, ['checkout', branch]);
}

/** Create a branch at current HEAD without switching to it. */
export async function gitBranch(cwd, branch) {
  await git(cwd, ['branch', branch]);
}
