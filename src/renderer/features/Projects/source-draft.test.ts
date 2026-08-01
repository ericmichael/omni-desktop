import { describe, expect, it } from 'vitest';

import { draftsToSources, emptyLocalDraft } from './source-draft';

describe('source drafts', () => {
  it('defaults new sources to writable', () => {
    const result = draftsToSources([{ ...emptyLocalDraft(), workspaceDir: '/repo/code', mountName: 'code' }]);

    expect(result.ok && result.sources[0]?.readOnly).toBeUndefined();
  });

  it('preserves a read-only selection', () => {
    const result = draftsToSources([
      { ...emptyLocalDraft(), workspaceDir: '/repo/reference', mountName: 'reference', readOnly: true },
    ]);

    expect(result.ok && result.sources[0]?.readOnly).toBe(true);
  });
});
