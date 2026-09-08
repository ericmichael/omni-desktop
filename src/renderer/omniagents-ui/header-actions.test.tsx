import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import {
  OmniAgentsHeaderActionsPortal,
  OmniAgentsHeaderActionsProvider,
  OmniAgentsHeaderActionsSlot,
} from './header-actions';

it('attaches header actions when their target mounts or is replaced', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (key: string) => (
    <OmniAgentsHeaderActionsProvider showArtifactsButton onArtifactsToggle={() => {}}>
      <OmniAgentsHeaderActionsSlot key={key} id="test-header-target" />
      <OmniAgentsHeaderActionsPortal targetId="test-header-target" />
    </OmniAgentsHeaderActionsProvider>
  );
  try {
    await act(async () => root.render(render('first')));
    expect(container.querySelector('#test-header-target button')).not.toBeNull();
    await act(async () => root.render(render('replacement')));
    expect(container.querySelector('#test-header-target button')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
