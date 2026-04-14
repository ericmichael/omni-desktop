/**
 * Git worktree operations used by the supervisor lifecycle. Extracted from
 * `project-manager.ts` (Sprint C2c.4) so both PM and `SupervisorOrchestrator`
 * can share one copy. These shell out to `git worktree` and persist state
 * in the launcher's worktrees directory.
 */

import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { getWorktreesDir } from '@/main/util';
import type { GitRepoInfo } from '@/shared/types';

const execFileAsync = promisify(execFile);

const ADJECTIVES = [
  'bold',
  'calm',
  'cool',
  'dark',
  'deep',
  'dry',
  'fast',
  'firm',
  'flat',
  'free',
  'full',
  'glad',
  'gold',
  'good',
  'gray',
  'hale',
  'keen',
  'kind',
  'last',
  'lean',
  'long',
  'loud',
  'mild',
  'neat',
  'pale',
  'pure',
  'rare',
  'rich',
  'ripe',
  'safe',
  'slim',
  'soft',
  'sure',
  'tall',
  'tame',
  'tidy',
  'tiny',
  'true',
  'vast',
  'warm',
  'wide',
  'wild',
  'wise',
  'aged',
  'airy',
  'apt',
  'bare',
  'blue',
  'busy',
  'cold',
];

const NOUNS = [
  'ant',
  'ape',
  'bat',
  'bear',
  'bee',
  'bird',
  'boar',
  'buck',
  'bull',
  'calf',
  'cat',
  'clam',
  'cod',
  'colt',
  'crab',
  'crow',
  'deer',
  'dog',
  'dove',
  'duck',
  'eagle',
  'eel',
  'elk',
  'fawn',
  'finch',
  'fish',
  'flea',
  'fly',
  'fox',
  'frog',
  'goat',
  'goose',
  'gull',
  'hare',
  'hawk',
  'hen',
  'hog',
  'horse',
  'jay',
  'lark',
  'lion',
  'lynx',
  'mare',
  'mink',
  'mole',
  'moth',
  'mule',
  'newt',
  'owl',
  'ox',
  'pike',
  'pony',
  'puma',
  'ram',
  'rat',
  'rook',
  'seal',
  'slug',
  'snail',
  'swan',
];

export const generateWorktreeName = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
};

export const createWorktree = async (workspaceDir: string, branch: string, name: string): Promise<string> => {
  const worktreesDir = getWorktreesDir();
  await fs.mkdir(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, name);
  const ticketBranch = `ticket/${name}`;

  await execFileAsync('git', ['-C', workspaceDir, 'worktree', 'add', '-b', ticketBranch, worktreePath, branch], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  return worktreePath;
};

export const checkGitRepo = async (workspaceDir: string): Promise<GitRepoInfo> => {
  try {
    await execFileAsync('git', ['-C', workspaceDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch {
    return { isGitRepo: false };
  }

  try {
    const [branchResult, currentResult] = await Promise.all([
      execFileAsync('git', ['-C', workspaceDir, 'branch', '--list', '--format=%(refname:short)'], {
        encoding: 'utf8',
        timeout: 5_000,
      }),
      execFileAsync('git', ['-C', workspaceDir, 'branch', '--show-current'], {
        encoding: 'utf8',
        timeout: 5_000,
      }),
    ]);

    const branches = branchResult.stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);

    const currentBranch = currentResult.stdout.trim();

    return { isGitRepo: true, branches, currentBranch };
  } catch {
    return { isGitRepo: false };
  }
};

export const removeWorktree = async (
  workspaceDir: string,
  worktreePath: string,
  worktreeName: string
): Promise<void> => {
  try {
    await execFileAsync('git', ['-C', workspaceDir, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (error) {
    console.warn(`Failed to remove worktree ${worktreePath}: ${error}`);
  }

  try {
    await execFileAsync('git', ['-C', workspaceDir, 'branch', '-D', `ticket/${worktreeName}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch (error) {
    console.warn(`Failed to delete branch ticket/${worktreeName}: ${error}`);
  }
};
