import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from '@/server/electron-shim';

describe('server Electron app shim', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the server working directory as the application path', () => {
    expect(app.getAppPath()).toBe(process.cwd());
  });

  it('supports an explicit application path for embedded servers', () => {
    vi.stubEnv('OMNI_LAUNCHER_APP_PATH', '/srv/omni-desktop');

    expect(app.getAppPath()).toBe('/srv/omni-desktop');
  });
});
