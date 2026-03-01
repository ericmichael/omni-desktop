/**
 * Shim for electron-store when running in server mode.
 * The ServerStore is passed directly; this shim exists to prevent import failures.
 */
export default class Store {
  constructor() {}
}
