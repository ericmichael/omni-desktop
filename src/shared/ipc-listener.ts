/**
 * Minimal IPC listener interface. Satisfied structurally by both
 * Electron's IpcListener<IpcEvents> (from @electron-toolkit/typed-ipc)
 * and by the server-mode ServerIpcAdapter. Using this interface as the
 * parameter type in manager factories lets server/managers.ts pass the
 * adapter without `as any` casts while Electron's real listener still
 * works via structural typing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IIpcListener {
  // The event parameter is typed `any` deliberately: Electron's real
  // IpcListener passes an `IpcMainInvokeEvent`, while ServerIpcAdapter
  // passes `null`. Using `any` makes this interface structurally
  // compatible with both without forcing either side to widen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: any, ...args: any[]) => any): void;
}
