// @vitest-environment node
import { startDeterministicModelServer } from 'tests/e2e/support/model-server';
import { expect, it } from 'vitest';

it('uses unique response/item identities across calls and stable identities within a stream', async () => {
  const server = await startDeterministicModelServer('fixture reply');
  try {
    const call = async () => {
      const response = await fetch(`${server.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.2', stream: true, input: [] }),
      });
      return (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
    };
    const first = await call();
    const second = await call();
    for (const events of [first, second]) {
      expect(events[0].response.id).toBe(events[4].response.id);
      expect(events[1].item.id).toBe(events[2].item_id);
      expect(events[1].item.id).toBe(events[3].item.id);
      expect(events[1].item.id).toBe(events[4].response.output[0].id);
    }
    expect(first[0].response.id).not.toBe(second[0].response.id);
    expect(first[1].item.id).not.toBe(second[1].item.id);
  } finally {
    await server.close();
  }
});
