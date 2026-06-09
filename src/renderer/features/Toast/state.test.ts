import { beforeEach, describe, expect, it } from 'vitest';

import { $toasts, toast } from './state';

beforeEach(() => {
  $toasts.set([]);
});

describe('toast state', () => {
  it('uses a positive default duration for error toasts', () => {
    toast.error('Launcher failed', 'Something went wrong');

    const [errorToast] = $toasts.get();
    expect(errorToast).toBeDefined();
    expect(errorToast).toMatchObject({
      level: 'error',
      title: 'Launcher failed',
      description: 'Something went wrong',
    });
    expect(errorToast!.durationMs).toBeGreaterThan(0);
  });

  it('keeps explicitly sticky error toasts sticky', () => {
    toast.error('Launcher failed', 'Something went wrong', { durationMs: 0 });

    expect($toasts.get()[0]?.durationMs).toBe(0);
  });
});
