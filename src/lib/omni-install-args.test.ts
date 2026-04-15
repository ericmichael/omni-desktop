import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

// Guard tests for src/main/omni-install-manager.ts. These assert that
// Windows-critical flags aren't silently dropped by a future refactor.
// We read the source as text rather than importing the module because
// OmniInstallManager depends on electron's `app`, which isn't available
// in the vitest environment.

const managerSource = fs.readFileSync(path.resolve(__dirname, '../main/omni-install-manager.ts'), 'utf8');
const utilSource = fs.readFileSync(path.resolve(__dirname, '../main/util.ts'), 'utf8');

describe('omni-install-manager', () => {
  test('uv venv is invoked with --link-mode=copy to avoid Windows hardlink failures', () => {
    expect(managerSource).toContain("'--link-mode'");
    expect(managerSource).toContain("'copy'");
  });

  test('uv executable is probed with --version before the install flow', () => {
    expect(managerSource).toContain("'--version'");
  });

  test('shellEnvSync is skipped on Windows', () => {
    expect(managerSource).toMatch(/process\.platform === 'win32' \? \{\} : shellEnvSync\(\)/);
  });

  test('install logs are opened and closed around startInstall', () => {
    expect(managerSource).toContain('openInstallLog');
    expect(managerSource).toContain('closeInstallLog');
  });

  test('dirty-venv recovery falls back to rename-aside', () => {
    expect(managerSource).toContain('removeOrRenameAside');
    expect(managerSource).toContain('.broken.');
    expect(managerSource).toContain('sweepBrokenVenvs');
  });

  test('preflight checks are called before the install runs', () => {
    expect(managerSource).toContain('checkLongPathsEnabled');
    expect(managerSource).toContain('checkDiskSpace');
    expect(managerSource).toContain('checkNetworkReachability');
  });

  test('LongPathsEnabled warning points users to the correct registry fix', () => {
    expect(managerSource).toContain('LongPathsEnabled');
    expect(managerSource).toMatch(/reg add.*LongPathsEnabled/);
  });

  test('legacy Windows runtime dir is migrated on startInstall', () => {
    expect(managerSource).toContain('migrateWindowsRuntimeDir');
  });
});

describe('util - runtime dir', () => {
  test('Windows runtime dir uses ~/.omni to stay under MAX_PATH', () => {
    expect(utilSource).toContain("'.omni'");
  });
});
