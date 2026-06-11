import { describe, expect, it } from 'vitest';

import { customAppPartition } from '@/lib/app-partition';

describe('customAppPartition', () => {
  it('creates a persistent Electron partition for custom apps', () => {
    expect(customAppPartition('teams')).toBe('persist:app-teams');
  });

  it('sanitizes app ids for partition names', () => {
    expect(customAppPartition('owner/app name')).toBe('persist:app-owner-app-name');
  });
});
