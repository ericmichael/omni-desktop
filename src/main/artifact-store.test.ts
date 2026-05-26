import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFsArtifactStore, parseDockerFindOutput } from '@/main/artifact-store';

describe('parseDockerFindOutput', () => {
  it('maps find rows to entries, sorted dirs-first then name', () => {
    const out = `${['f\t12\t1700000000.5\tz.txt', 'd\t4096\t1700000001\tsub', 'f\t3\t1700000002\ta.md'].join('\n')  }\n`;
    const entries = parseDockerFindOutput(out);
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.md', 'z.txt']);
    expect(entries[0]).toMatchObject({ name: 'sub', isDirectory: true });
    expect(entries.find((e) => e.name === 'z.txt')).toMatchObject({ size: 12, modifiedAt: 1700000000500 });
  });

  it('prefixes relativePath with dirPath and ignores blank lines', () => {
    const entries = parseDockerFindOutput('f\t1\t1\tnote.md\n\n', 'pr');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.relativePath).toBe('pr/note.md');
  });
});

describe('HostFsArtifactStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omni-artstore-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write → list → read round-trips a text artifact', async () => {
    const store = new HostFsArtifactStore(dir);
    await store.write('t1', 'pr/PR_TITLE.md', Buffer.from('Add widget\n', 'utf-8'));

    const top = await store.list('t1');
    expect(top.map((e) => e.name)).toContain('pr');

    const inPr = await store.list('t1', 'pr');
    expect(inPr.map((e) => e.name)).toEqual(['PR_TITLE.md']);

    const content = await store.read('t1', 'pr/PR_TITLE.md');
    expect(content.textContent).toBe('Add widget\n');
    expect(content.mimeType).toMatch(/markdown|text/);
  });

  it('lists empty for a ticket with no artifacts', async () => {
    expect(await new HostFsArtifactStore(dir).list('absent')).toEqual([]);
  });
});
