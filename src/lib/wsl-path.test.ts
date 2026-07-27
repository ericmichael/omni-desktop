import { describe, expect, it } from 'vitest';

import { winToWslPath } from '@/lib/wsl-path';

describe('winToWslPath', () => {
  describe('drive-absolute paths', () => {
    it('translates a backslash path, lowercasing the drive letter', () => {
      expect(winToWslPath('C:\\Users\\Me\\proj')).toBe('/mnt/c/Users/Me/proj');
    });

    it('accepts forward slashes', () => {
      expect(winToWslPath('C:/Users/Me')).toBe('/mnt/c/Users/Me');
    });

    it('accepts mixed slashes', () => {
      expect(winToWslPath('C:\\Users/Me')).toBe('/mnt/c/Users/Me');
    });

    it('accepts a lowercase drive letter', () => {
      expect(winToWslPath('c:\\Users\\Me')).toBe('/mnt/c/Users/Me');
    });

    it('handles drives other than C:', () => {
      expect(winToWslPath('D:\\data\\sets')).toBe('/mnt/d/data/sets');
      expect(winToWslPath('z:\\')).toBe('/mnt/z');
    });

    it('preserves spaces and special characters verbatim', () => {
      expect(winToWslPath('C:\\Program Files (x86)\\My App')).toBe('/mnt/c/Program Files (x86)/My App');
      expect(winToWslPath("C:\\Users\\Me\\a & b's #1 [proj]")).toBe("/mnt/c/Users/Me/a & b's #1 [proj]");
    });

    it('strips a single trailing slash', () => {
      expect(winToWslPath('C:\\Users\\')).toBe('/mnt/c/Users');
      expect(winToWslPath('C:/Users/')).toBe('/mnt/c/Users');
    });

    it('maps bare drive roots to the mount root', () => {
      expect(winToWslPath('C:\\')).toBe('/mnt/c');
      expect(winToWslPath('C:/')).toBe('/mnt/c');
      expect(winToWslPath('C:')).toBe('/mnt/c');
    });

    it('collapses multiple consecutive slashes', () => {
      expect(winToWslPath('C:\\\\Users\\\\\\Me')).toBe('/mnt/c/Users/Me');
      expect(winToWslPath('C://Users//Me//')).toBe('/mnt/c/Users/Me');
    });
  });

  describe('WSL UNC paths', () => {
    it('maps \\\\wsl$\\<distro> paths to the in-distro native path', () => {
      expect(winToWslPath('\\\\wsl$\\Ubuntu\\home\\me')).toBe('/home/me');
    });

    it('maps \\\\wsl.localhost\\<distro> paths to the in-distro native path', () => {
      expect(winToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe('/home/me');
    });

    it('matches the host token case-insensitively', () => {
      expect(winToWslPath('\\\\WSL$\\Ubuntu\\home\\me')).toBe('/home/me');
      expect(winToWslPath('\\\\Wsl.LocalHost\\Ubuntu\\home\\me')).toBe('/home/me');
    });

    it('maps a bare distro root to /', () => {
      expect(winToWslPath('\\\\wsl$\\Ubuntu')).toBe('/');
      expect(winToWslPath('\\\\wsl$\\Ubuntu\\')).toBe('/');
    });

    it('handles deep paths, distro names with punctuation, and spaces', () => {
      expect(winToWslPath('\\\\wsl$\\Ubuntu-22.04\\home\\me\\dev\\my proj')).toBe('/home/me/dev/my proj');
    });

    it('accepts forward and mixed slashes', () => {
      expect(winToWslPath('//wsl$/Ubuntu/home/me')).toBe('/home/me');
      expect(winToWslPath('\\\\wsl.localhost\\Ubuntu/home/me')).toBe('/home/me');
    });

    it('rejects a WSL host with no distro segment', () => {
      expect(winToWslPath('\\\\wsl$')).toBeNull();
      expect(winToWslPath('\\\\wsl$\\')).toBeNull();
    });

    it('rejects non-WSL UNC shares', () => {
      expect(winToWslPath('\\\\server\\share')).toBeNull();
      expect(winToWslPath('\\\\wslx\\Ubuntu\\home')).toBeNull();
    });
  });

  describe('already-POSIX absolute paths', () => {
    it('returns them unchanged', () => {
      expect(winToWslPath('/home/me')).toBe('/home/me');
      expect(winToWslPath('/mnt/c/Users/Me')).toBe('/mnt/c/Users/Me');
    });

    it('strips a single trailing slash', () => {
      expect(winToWslPath('/home/me/')).toBe('/home/me');
    });

    it('keeps the bare root as /', () => {
      expect(winToWslPath('/')).toBe('/');
    });

    it('collapses multiple consecutive slashes', () => {
      expect(winToWslPath('/home//me///dev')).toBe('/home/me/dev');
    });
  });

  describe('untranslatable inputs', () => {
    it('rejects the empty string', () => {
      expect(winToWslPath('')).toBeNull();
    });

    it('rejects relative paths', () => {
      expect(winToWslPath('foo\\bar')).toBeNull();
      expect(winToWslPath('foo/bar')).toBeNull();
      expect(winToWslPath('.')).toBeNull();
      expect(winToWslPath('..')).toBeNull();
    });

    it('rejects drive-relative paths', () => {
      expect(winToWslPath('C:foo')).toBeNull();
      expect(winToWslPath('C:foo\\bar')).toBeNull();
    });

    it('rejects drive-rooted relative paths', () => {
      expect(winToWslPath('\\Users\\Me')).toBeNull();
    });

    it('rejects malformed drive specifiers', () => {
      expect(winToWslPath('CC:\\Users')).toBeNull();
      expect(winToWslPath('1:\\Users')).toBeNull();
    });
  });
});
