/**
 * Tests for pure utility functions in util.ts — slugify, path validation,
 * platform detection, torch platform mapping, shell selection, and venv
 * activation command generation.
 *
 * Functions that depend on Electron's `app` module (getOmniRuntimeDir, etc.)
 * are not tested here — they require electron-mock or E2E.
 */
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProductDescribePayload, setCachedProductRuntimeInfo } from '@/lib/product';
import {
  getActivateVenvCommand,
  getCliInstalledPath,
  getOmniCliPath,
  getOmniConfigDir,
  getOperatingSystem,
  getShell,
  getTorchPlatform,
  MAX_USER_PATH_DEPTH,
  slugify,
  validateConfigPath,
  validateUserPath,
} from '@/main/util';

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My Project')).toBe('my-project');
  });

  it('collapses consecutive non-alphanumeric chars into one hyphen', () => {
    expect(slugify('Hello   World!!!')).toBe('hello-world');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---leading---')).toBe('leading');
  });

  it('handles unicode by stripping non-ascii', () => {
    expect(slugify('Café Résumé')).toBe('caf-r-sum');
  });

  it('truncates to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('returns "project" for empty string', () => {
    expect(slugify('')).toBe('project');
  });

  it('returns "project" for all-special-chars input', () => {
    expect(slugify('!!!')).toBe('project');
  });

  it('preserves digits', () => {
    expect(slugify('Sprint 42 Alpha')).toBe('sprint-42-alpha');
  });
});

// ---------------------------------------------------------------------------
// validateConfigPath
// ---------------------------------------------------------------------------

describe('validateConfigPath', () => {
  const configDir = '/home/user/.config/omni';

  it('accepts a file directly inside configDir', () => {
    expect(() => validateConfigPath('/home/user/.config/omni/settings.json', configDir)).not.toThrow();
  });

  it('accepts nested paths inside configDir', () => {
    expect(() => validateConfigPath('/home/user/.config/omni/sub/deep/file.json', configDir)).not.toThrow();
  });

  it('accepts configDir itself', () => {
    expect(() => validateConfigPath(configDir, configDir)).not.toThrow();
  });

  it('rejects paths outside configDir', () => {
    expect(() => validateConfigPath('/home/user/.config/other/file.json', configDir)).toThrow('Access denied');
  });

  it('rejects .. traversal escaping configDir', () => {
    expect(() => validateConfigPath('/home/user/.config/omni/../other/secret', configDir)).toThrow('Access denied');
  });

  it('rejects sibling directory prefix bypass', () => {
    // /home/user/.config/omni-evil should NOT pass even though it starts with the configDir string
    expect(() => validateConfigPath('/home/user/.config/omni-evil/file.json', configDir)).toThrow('Access denied');
  });

  it('rejects null bytes', () => {
    expect(() => validateConfigPath('/home/user/.config/omni/file\0.json', configDir)).toThrow('null byte');
  });
});

// ---------------------------------------------------------------------------
// validateUserPath
// ---------------------------------------------------------------------------

describe('validateUserPath', () => {
  it('accepts normal paths', () => {
    expect(() => validateUserPath('/home/user/projects/foo')).not.toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => validateUserPath('/home/user/\0evil')).toThrow('null byte');
  });

  it('accepts deep paths when checkDepth is false (default)', () => {
    const deep = `/${Array.from({ length: 50 }, (_, i) => `d${i}`).join('/')}`;
    expect(() => validateUserPath(deep)).not.toThrow();
  });

  it('rejects excessively deep paths when checkDepth is true', () => {
    const deep = `/${Array.from({ length: MAX_USER_PATH_DEPTH + 1 }, (_, i) => `d${i}`).join('/')}`;
    expect(() => validateUserPath(deep, { checkDepth: true })).toThrow('maximum depth');
  });

  it('accepts paths at exactly MAX_USER_PATH_DEPTH when checkDepth is true', () => {
    const exactDepth = `/${Array.from({ length: MAX_USER_PATH_DEPTH }, (_, i) => `d${i}`).join('/')}`;
    expect(() => validateUserPath(exactDepth, { checkDepth: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getOperatingSystem
// ---------------------------------------------------------------------------

describe('getOperatingSystem', () => {
  it('returns a valid OS string for the current platform', () => {
    const os = getOperatingSystem();
    expect(['Windows', 'macOS', 'Linux']).toContain(os);
  });

  // Platform-specific — at least one of these will run depending on CI
  it('matches the current platform', () => {
    const os = getOperatingSystem();
    if (process.platform === 'win32') {
      expect(os).toBe('Windows');
    } else if (process.platform === 'darwin') {
      expect(os).toBe('macOS');
    } else {
      expect(os).toBe('Linux');
    }
  });
});

// ---------------------------------------------------------------------------
// getTorchPlatform
// ---------------------------------------------------------------------------

describe('getTorchPlatform', () => {
  // On macOS, all GPU types map to 'cpu' (MPS handled transparently)
  if (process.platform === 'darwin') {
    it.each(['nvidia>=30xx', 'nvidia<30xx', 'amd', 'nogpu'] as const)(
      'returns cpu on macOS regardless of gpuType=%s',
      (gpuType) => {
        expect(getTorchPlatform(gpuType)).toBe('cpu');
      }
    );
  } else {
    it('maps nvidia>=30xx to cuda', () => {
      expect(getTorchPlatform('nvidia>=30xx')).toBe('cuda');
    });

    it('maps nvidia<30xx to cuda', () => {
      expect(getTorchPlatform('nvidia<30xx')).toBe('cuda');
    });

    it('maps amd to rocm', () => {
      expect(getTorchPlatform('amd')).toBe('rocm');
    });

    it('maps nogpu to cpu', () => {
      expect(getTorchPlatform('nogpu')).toBe('cpu');
    });
  }
});

// ---------------------------------------------------------------------------
// getShell
// ---------------------------------------------------------------------------

describe('getShell', () => {
  it('returns a non-empty string', () => {
    expect(getShell().length).toBeGreaterThan(0);
  });

  it('matches platform expectations', () => {
    const shell = getShell();
    if (process.platform === 'win32') {
      expect(shell).toBe('Powershell.exe');
    } else if (process.platform === 'darwin') {
      expect(shell).toBe('/bin/zsh');
    } else {
      expect(shell).toBe('/bin/bash');
    }
  });
});

// ---------------------------------------------------------------------------
// getActivateVenvCommand
// ---------------------------------------------------------------------------

describe('getActivateVenvCommand', () => {
  it('uses source on unix', () => {
    if (process.platform === 'win32') {
      return;
    }
    const cmd = getActivateVenvCommand('/opt/omni');
    expect(cmd).toContain('source');
    expect(cmd).toContain(path.join('/opt/omni', '.venv', 'bin', 'activate'));
  });

  it('uses & (call operator) on windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const cmd = getActivateVenvCommand('C:\\omni');
    expect(cmd.startsWith('& ')).toBe(true);
    expect(cmd).toContain('Activate.ps1');
  });

  it('wraps the path in double quotes', () => {
    const cmd = getActivateVenvCommand('/path/with spaces/omni');
    expect(cmd).toContain('"');
  });
});

// ---------------------------------------------------------------------------
// Product-keyed paths (omni-code parity)
//
// With omni-code as the bundled product, every path resolved through the
// ProductDefinition / describe --json threading must equal what the
// pre-refactor hardcoded literals produced. Electron is aliased to the
// server shim under vitest (see vitest.config.ts), so app.getPath resolves
// real homedir-based paths.
// ---------------------------------------------------------------------------

describe('product-keyed paths (omni-code parity)', () => {
  const isWindows = process.platform === 'win32';
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['OMNI_CLI_PATH', 'OMNI_CODE_DEV_PATH', 'XDG_CONFIG_HOME']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    setCachedProductRuntimeInfo(null);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setCachedProductRuntimeInfo(null);
  });

  it('venv CLI path ends with the historical omni binary name', () => {
    const expectedTail = isWindows ? path.join('Scripts', 'omni.exe') : path.join('bin', 'omni');
    expect(getOmniCliPath().endsWith(path.join('.venv', expectedTail))).toBe(true);
  });

  it('PATH-install location matches the historical omni name', () => {
    const expectedTail = isWindows ? path.join('omni', 'omni.cmd') : path.join('.local', 'bin', 'omni');
    expect(getCliInstalledPath().endsWith(expectedTail)).toBe(true);
  });

  it('config dir pre-describe fallback matches the historical convention', () => {
    const expectedTail = isWindows ? 'OmniCode' : path.join('.config', 'omni_code');
    expect(getOmniConfigDir().endsWith(expectedTail)).toBe(true);
  });

  it('config dir honors XDG_CONFIG_HOME on non-Windows platforms', () => {
    if (isWindows) {
      return;
    }
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    expect(getOmniConfigDir()).toBe(path.join('/custom/xdg', 'omni_code'));
  });

  it('config dir prefers the config_dir reported by describe --json once cached', () => {
    setCachedProductRuntimeInfo(
      parseProductDescribePayload({
        name: 'omni-code',
        prog: 'omni',
        label: 'Omni Code',
        slug: 'omni_code',
        version: '0.6.17',
        config_dir: '/described/config/omni_code',
        env_prefix: 'OMNI_CODE',
        update: null,
        serve_protocol: 1,
      })
    );
    expect(getOmniConfigDir()).toBe('/described/config/omni_code');
  });
});
