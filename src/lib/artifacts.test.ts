/**
 * Tests for artifacts.ts — path construction for ticket artifact directories.
 */
import { describe, expect, it } from 'vitest';

import { getArtifactsDir, getContainerArtifactsDir } from '@/lib/artifacts';

describe('getArtifactsDir', () => {
  it('constructs the correct host-side path with forward slashes', () => {
    const result = getArtifactsDir('/home/user/.config/omni', 'ticket-123');
    expect(result).toBe('/home/user/.config/omni/tickets/ticket-123/artifacts');
  });

  it('works with different config directories', () => {
    const result = getArtifactsDir('/tmp/config', 'abc');
    expect(result).toBe('/tmp/config/tickets/abc/artifacts');
  });

  it('strips a trailing slash or backslash from configDir', () => {
    expect(getArtifactsDir('/tmp/config/', 'abc')).toBe('/tmp/config/tickets/abc/artifacts');
    expect(getArtifactsDir('C:\\tmp\\config\\', 'abc')).toBe('C:\\tmp\\config/tickets/abc/artifacts');
  });
});

describe('getContainerArtifactsDir', () => {
  it('is the per-ticket dir under the workspace .omni-artifacts dir', () => {
    expect(getContainerArtifactsDir('ticket-123')).toBe('/workspace/.omni-artifacts/ticket-123');
  });

  it('always uses forward slashes regardless of OS', () => {
    expect(getContainerArtifactsDir('abc')).not.toContain('\\');
  });
});
