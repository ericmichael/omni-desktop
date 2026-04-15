/**
 * Tests for artifacts.ts — path construction for ticket artifact directories.
 */
import { join } from 'node:path';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getArtifactsDir, getContainerArtifactsDir } from '@/lib/artifacts';

describe('getArtifactsDir', () => {
  it('constructs the correct host-side path', () => {
    const result = getArtifactsDir('/home/user/.config/omni', 'ticket-123');
    expect(result).toBe(join('/home/user/.config/omni', 'tickets', 'ticket-123', 'artifacts'));
  });

  it('works with different config directories', () => {
    const result = getArtifactsDir('/tmp/config', 'abc');
    expect(result).toBe(join('/tmp/config', 'tickets', 'abc', 'artifacts'));
  });
});

describe('getContainerArtifactsDir', () => {
  it('constructs the correct container-side path using posix separators', () => {
    const result = getContainerArtifactsDir('ticket-123');
    expect(result).toBe('/home/user/.config/omni_code/tickets/ticket-123/artifacts');
  });

  it('always uses forward slashes regardless of OS', () => {
    const result = getContainerArtifactsDir('abc');
    expect(result).not.toContain('\\');
  });
});
