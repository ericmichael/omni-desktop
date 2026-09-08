// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { destroySandboxState } from './sandbox-state';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-cleanup-state-'));
  dirs.push(dir);
  const file = path.join(dir, 'workspace.json');
  const original = JSON.stringify({ container_id: 'container-old' });
  writeFileSync(file, original);
  const execFileFn = vi.fn(async () => ({ stdout: '', stderr: '' }));
  return { dir, file, original, execFileFn, deps: { execFileFn, getEnv: () => ({}) } };
}

it('preserves the recovery record through Docker outage and removes it on successful retry', async () => {
  const f = fixture();
  f.execFileFn.mockRejectedValue(new Error('daemon offline'));
  await expect(destroySandboxState('workspace', f.deps, f.dir)).rejects.toThrow('daemon offline');
  expect(readFileSync(f.file, 'utf8')).toBe(f.original);
  f.execFileFn.mockResolvedValue({ stdout: '', stderr: '' });
  await destroySandboxState('workspace', f.deps, f.dir);
  expect(existsSync(f.file)).toBe(false);
});

it('does not acknowledge a failed removal while the container still exists', async () => {
  const f = fixture();
  f.execFileFn.mockRejectedValueOnce(new Error('permission denied'));
  f.execFileFn.mockResolvedValueOnce({ stdout: 'container-old\n', stderr: '' });
  await expect(destroySandboxState('workspace', f.deps, f.dir)).rejects.toThrow('permission denied');
  expect(readFileSync(f.file, 'utf8')).toBe(f.original);
});

it('reconciles an ambiguous removal only after the daemon proves absence', async () => {
  const f = fixture();
  f.execFileFn.mockRejectedValueOnce(new Error('reply lost'));
  await destroySandboxState('workspace', f.deps, f.dir);
  expect(f.execFileFn).toHaveBeenCalledTimes(2);
  expect(f.execFileFn).toHaveBeenLastCalledWith(
    'docker',
    ['ps', '-a', '--no-trunc', '--filter', 'id=container-old', '--format', '{{.ID}}'],
    expect.anything()
  );
  expect(existsSync(f.file)).toBe(false);
});

it('does not erase a replacement ownership record written during removal', async () => {
  const f = fixture();
  const replacement = JSON.stringify({ container_id: 'container-new' });
  f.execFileFn.mockImplementationOnce(async () => {
    writeFileSync(f.file, replacement);
    return { stdout: '', stderr: '' };
  });
  await expect(destroySandboxState('workspace', f.deps, f.dir)).rejects.toThrow('ownership changed');
  expect(readFileSync(f.file, 'utf8')).toBe(replacement);
});

it.each(['{broken', '{}', 'null'])('preserves malformed recovery data: %s', async (invalid) => {
  const f = fixture();
  writeFileSync(f.file, invalid);
  await expect(destroySandboxState('workspace', f.deps, f.dir)).rejects.toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe(invalid);
  expect(f.execFileFn).not.toHaveBeenCalled();
});

it('is idempotent when the record is already absent', async () => {
  const f = fixture();
  rmSync(f.file);
  await destroySandboxState('workspace', f.deps, f.dir);
  expect(f.execFileFn).not.toHaveBeenCalled();
});
