import { atom } from 'nanostores';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openFreshChat: vi.fn(),
  setLayoutMode: vi.fn(),
  setKey: vi.fn(),
  store: { onboardingComplete: true, layoutMode: 'work' },
}));

vi.mock('@/renderer/features/Code/state', () => ({
  codeApi: {
    openFreshChat: mocks.openFreshChat,
    setLayoutMode: mocks.setLayoutMode,
  },
}));

vi.mock('@/renderer/services/store', () => ({
  $initialized: atom(true),
  persistedStoreApi: {
    get: () => mocks.store,
    setKey: mocks.setKey,
  },
}));

describe('boot landing', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.openFreshChat.mockReset();
    mocks.setLayoutMode.mockReset();
    mocks.setKey.mockReset();
    mocks.store.onboardingComplete = true;
    mocks.store.layoutMode = 'work';
  });

  it('opens a fresh chat and preserves the chosen layout mode', async () => {
    const { initBootLanding } = await import('./boot-landing');

    initBootLanding();

    expect(mocks.setKey).toHaveBeenCalledWith('layoutMode', 'chat');
    expect(mocks.openFreshChat).toHaveBeenCalledOnce();
    expect(mocks.setLayoutMode).not.toHaveBeenCalled();
  });
});
