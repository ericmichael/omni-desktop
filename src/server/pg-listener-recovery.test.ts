// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createPgPool, runPgMigrations } from 'omni-projects-db';
import { createPgListener } from 'packages/projects-db/src/pg/connection';
import { expect, it } from 'vitest';

import { CompositeSettingsStore } from './composite-settings-store';

const url = process.env.OMNI_TEST_SETTINGS_PG_URL;
it.skipIf(!url)('reconnects LISTEN and repairs settings changed while notifications were lost', async () => {
  const pool = createPgPool(url!);
  const listenerUrl = new URL(url!);
  const application = `listener-audit-${randomUUID()}`;
  listenerUrl.searchParams.set('application_name', application);
  let stop: (() => Promise<void>) | undefined;
  try {
    await runPgMigrations(pool);
    const principal = randomUUID();
    await pool.query('INSERT INTO users (id) VALUES ($1)', [principal]);
    const reader = new CompositeSettingsStore(pool, principal, principal);
    const writer = new CompositeSettingsStore(pool, principal, principal);
    await Promise.all([reader.whenReady, writer.whenReady]);
    let reconnects = 0;
    const notifications: string[] = [];
    stop = await createPgListener(listenerUrl.toString(), 'omni_change', (payload) => notifications.push(payload), {
      retryDelayMs: 150,
      onReconnect: () => {
        reconnects++;
        void reader.reloadUser();
      },
    });
    await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [
      application,
    ]);
    writer.set('defaultProfileName', 'missed-notification-marker');
    await writer.flush();
    await expect.poll(() => reconnects, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => reader.get('defaultProfileName')).toBe('missed-notification-marker');
    await pool.query("SELECT pg_notify('omni_change', 'after-reconnect')");
    await expect.poll(() => notifications.includes('after-reconnect')).toBe(true);
    await stop();
    stop = undefined;
    await expect
      .poll(async () =>
        Number(
          (await pool.query('SELECT count(*) FROM pg_stat_activity WHERE application_name = $1', [application])).rows[0]
            .count
        )
      )
      .toBe(0);
  } finally {
    await stop?.();
    await pool.end();
  }
});
