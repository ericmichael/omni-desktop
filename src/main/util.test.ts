/**
 * Tests for pure utility functions in util.ts — slugify, path validation,
 * platform detection, torch platform mapping, shell selection, and venv
 * activation command generation.
 *
 * Functions that depend on Electron's `app` module (getOmniRuntimeDir, etc.)
 * are not tested here — they require electron-mock or E2E.
 */
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  getActivateVenvCommand,
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
    const deep = '/' + Array.from({ length: 50 }, (_, i) => `d${i}`).join('/');
    expect(() => validateUserPath(deep)).not.toThrow();
  });

  it('rejects excessively deep paths when checkDepth is true', () => {
    const deep = '/' + Array.from({ length: MAX_USER_PATH_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
    expect(() => validateUserPath(deep, { checkDepth: true })).toThrow('maximum depth');
  });

  it('accepts paths at exactly MAX_USER_PATH_DEPTH when checkDepth is true', () => {
    const exactDepth = '/' + Array.from({ length: MAX_USER_PATH_DEPTH }, (_, i) => `d${i}`).join('/');
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
    if (process.platform === 'win32') expect(os).toBe('Windows');
    else if (process.platform === 'darwin') expect(os).toBe('macOS');
    else expect(os).toBe('Linux');
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
    if (process.platform === 'win32') return;
    const cmd = getActivateVenvCommand('/opt/omni');
    expect(cmd).toContain('source');
    expect(cmd).toContain(path.join('/opt/omni', '.venv', 'bin', 'activate'));
  });

  it('uses & (call operator) on windows', () => {
    if (process.platform !== 'win32') return;
    const cmd = getActivateVenvCommand('C:\\omni');
    expect(cmd).toStartWith('& ');
    expect(cmd).toContain('Activate.ps1');
  });

  it('wraps the path in double quotes', () => {
    const cmd = getActivateVenvCommand('/path/with spaces/omni');
    expect(cmd).toContain('"');
  });
});
