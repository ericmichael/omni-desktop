import { afterEach, expect, it, vi } from 'vitest';

import { encodeMessage } from './encode-message';

afterEach(() => vi.unstubAllGlobals());

it.each(['image/png', 'text/plain'])('rejects an aborted %s attachment read instead of hanging', async (type) => {
  class AbortedReader {
    onabort?: () => void;
    readAsDataURL() {
      queueMicrotask(() => this.onabort?.());
    }
    readAsArrayBuffer() {
      queueMicrotask(() => this.onabort?.());
    }
  }
  vi.stubGlobal('FileReader', AbortedReader);
  await expect(encodeMessage('keep me', [new File(['bytes'], 'original.txt', { type })])).rejects.toThrow('cancelled');
});

it('preserves file bytes and ordering across mixed attachments', async () => {
  const result = await encodeMessage('prompt', [
    new File(['image'], 'a.png', { type: 'image/png' }),
    new File(['document'], 'b.txt', { type: 'text/plain' }),
  ]);
  expect(result.attachments.map((item) => item.filename)).toEqual(['a.png', 'b.txt']);
  expect(result.content[1].image_url).toBe('data:image/png;base64,aW1hZ2U=');
  expect(result.content[2].file_data).toBe(btoa('document'));
});
