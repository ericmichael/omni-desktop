import Store from 'electron-store';

import { schema } from '@/shared/types';

let _store: Store | undefined;

/** Lazily-initialized singleton — avoids crashing in non-Electron contexts (vitest). */
export function getStore(): Store {
  if (!_store) {
    _store = new Store({ schema, clearInvalidConfig: true, watch: true });
  }
  return _store;
}

/**
 * @deprecated Prefer `getStore()` for lazy initialization. This eager export
 * exists only for back-compat with call sites that use `store` directly.
 */
export const store = new Proxy({} as Store, {
  get(_target, prop, receiver) {
    return Reflect.get(getStore(), prop, receiver);
  },
  set(_target, prop, value, receiver) {
    return Reflect.set(getStore(), prop, value, receiver);
  },
});
