import Store from 'electron-store';

import { schema, type StoreData } from '@/shared/types';

let _store: Store<StoreData> | undefined;

/**
 * Lazily-initialized singleton. Lazy construction matters for two reasons:
 * (1) tests import main-process modules without Electron's `app`, and
 * (2) electron-store is backed by `conf`, which uses private class fields
 *     accessed through an internal Proxy — wrapping the Store in another
 *     Proxy (e.g. for a back-compat `store` export) breaks those reads
 *     with "Cannot read private member #options". Always call `getStore()`
 *     and use the returned instance directly.
 */
export function getStore(): Store<StoreData> {
  if (!_store) {
    _store = new Store<StoreData>({ schema, clearInvalidConfig: true, watch: true });
  }
  return _store;
}
