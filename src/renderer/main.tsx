import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/renderer/app/App';
import { logAsciiWordmark } from '@/renderer/common/AsciiLogo';

// The retired ASCII wordmark, now a boot easter egg for whoever opens devtools.
logAsciiWordmark();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
