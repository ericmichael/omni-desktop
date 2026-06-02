import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitter } from '@/renderer/services/ipc';
import type { ContainerPullRequest } from '@/shared/types';

import { requestPreviewOpen } from './preview-bridge';
import { PullRequestBanner } from './PullRequestBanner';

vi.mock('@fluentui/react-components', () => ({
  makeStyles: () => () => ({
    banner: 'banner',
    floating: 'floating',
    label: 'label',
    prBadge: 'prBadge',
  }),
  mergeClasses: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
  shorthands: {
    border: () => ({}),
    borderBottom: () => ({}),
    borderLeft: () => ({}),
  },
  tokens: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@fluentui/react-icons', () => ({
  Open16Regular: () => <span data-testid="open-icon" />,
}));

vi.mock('@/renderer/services/ipc', () => ({
  emitter: {
    invoke: vi.fn(),
  },
}));

vi.mock('./preview-bridge', () => ({
  requestPreviewOpen: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pullRequest: ContainerPullRequest = {
  number: 42,
  url: 'https://github.com/acme/app/pull/42',
  state: 'OPEN',
  sourceMountName: 'omni-desktop',
};

let container: HTMLDivElement;
let root: Root;

const invokeMock = vi.mocked(emitter.invoke);
const requestPreviewOpenMock = vi.mocked(requestPreviewOpen);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  invokeMock.mockResolvedValue([pullRequest]);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

async function renderBanner(
  scope: { kind: 'chat' } | { kind: 'code-tab'; tabId: string }
): Promise<HTMLSpanElement> {
  await act(async () => {
    root.render(<PullRequestBanner scope={scope} />);
    await Promise.resolve();
  });
  const badge = container.querySelector('[role="button"]');
  if (!badge) {
    throw new Error('PR badge not found');
  }
  return badge as HTMLSpanElement;
}

describe('PullRequestBanner PR links', () => {
  it('opens code-tab pull requests in the originating tab preview', async () => {
    const badge = await renderBanner({ kind: 'code-tab', tabId: 'tab_123' });

    expect(badge.textContent).toContain('omni-desktop · PR #42');

    act(() => {
      badge.click();
    });

    expect(invokeMock).toHaveBeenCalledWith('project:detect-code-tab-pull-requests', 'tab_123');
    expect(requestPreviewOpenMock).toHaveBeenCalledWith(pullRequest.url, 'tab_123');
  });

  it('keeps chat pull requests untargeted', async () => {
    const badge = await renderBanner({ kind: 'chat' });

    act(() => {
      badge.click();
    });

    expect(invokeMock).toHaveBeenCalledWith('project:detect-chat-pull-requests');
    expect(requestPreviewOpenMock).toHaveBeenCalledWith(pullRequest.url);
  });
});
