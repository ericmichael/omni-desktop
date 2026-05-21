/**
 * Per-tenant settings store backed by the Postgres `user_settings` JSONB row.
 *
 * Drop-in for {@link ServerStore} (same get/set/delete/clear/store/onDidAnyChange
 * surface) so the managers consume it unchanged. Reads/writes are synchronous
 * against an in-memory cache hydrated once from Postgres ({@link whenReady},
 * awaited by the server's tenant-readiness gate); writes update the cache
 * immediately and flush full-document write-through to Postgres in order.
 */
import { loadTenantSettings, type PgPool, saveTenantSettings } from 'omni-projects-db';

import { DEFAULTS } from '@/server/store';
import type { StoreData } from '@/shared/types';

type ChangeCallback = (data: StoreData | undefined) => void;

export class PgSettingsStore {
  private data: StoreData = { ...DEFAULTS };
  private changeCallbacks = new Set<ChangeCallback>();
  private persistChain: Promise<void> = Promise.resolve();
  /** Resolves once the cache has been hydrated from Postgres. */
  readonly whenReady: Promise<void>;

  constructor(
    private readonly pool: PgPool,
    private readonly tenantId: string,
    private readonly originId = ''
  ) {
    this.whenReady = this.load();
  }

  private async load(): Promise<void> {
    try {
      const row = await loadTenantSettings(this.pool, this.tenantId);
      if (row) {
        this.data = { ...DEFAULTS, ...(row as Partial<StoreData>) };
      } else {
        await saveTenantSettings(
          this.pool,
          this.tenantId,
          this.data as unknown as Record<string, unknown>,
          this.originId
        );
      }
    } catch (err) {
      console.error(`[PgSettingsStore] load failed for tenant ${this.tenantId}:`, err);
    }
    // Fire subscribers (e.g. platform-client sync) now that real prefs are in.
    this.notify();
  }

  /** Re-load from Postgres (called when another replica changed this tenant's settings). */
  async reload(): Promise<void> {
    await this.load();
  }

  private persist(): void {
    const snapshot = { ...this.data } as unknown as Record<string, unknown>;
    this.persistChain = this.persistChain.then(() =>
      saveTenantSettings(this.pool, this.tenantId, snapshot, this.originId).catch((err) =>
        console.error(`[PgSettingsStore] persist failed for tenant ${this.tenantId}:`, err)
      )
    );
  }

  private notify(): void {
    for (const cb of this.changeCallbacks) {
      cb(this.data);
    }
  }

  get store(): StoreData {
    return this.data;
  }

  set store(data: StoreData) {
    this.data = data;
    this.persist();
    this.notify();
  }

  get<K extends keyof StoreData>(key: K, defaultValue?: StoreData[K]): StoreData[K] {
    const val = this.data[key];
    return val !== undefined ? val : (defaultValue as StoreData[K]);
  }

  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  set(data: Partial<StoreData>): void;
  set<K extends keyof StoreData>(keyOrData: K | Partial<StoreData>, value?: StoreData[K]): void {
    if (typeof keyOrData === 'string') {
      (this.data as Record<string, unknown>)[keyOrData] = value;
    } else {
      Object.assign(this.data, keyOrData);
    }
    this.persist();
    this.notify();
  }

  delete<K extends keyof StoreData>(key: K): void {
    delete (this.data as Record<string, unknown>)[key];
    this.persist();
    this.notify();
  }

  clear(): void {
    this.data = { ...DEFAULTS };
    this.persist();
    this.notify();
  }

  onDidAnyChange(callback: ChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /** Await pending write-through (cleanup / durability barrier). */
  flush(): Promise<void> {
    return this.persistChain;
  }
}
