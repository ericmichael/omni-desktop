/** A capability probe owns its temporary socket, including failed connects. */
export async function probeRealtimeCapabilities(url: string, token: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const { RealtimeRPCClient } = await import('./rpc/realtime');
  signal.throwIfAborted();
  const client = new RealtimeRPCClient(url, token);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      client.disconnect();
    }
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    await client.connect();
    signal.throwIfAborted();
    const capabilities = await client.capabilities();
    signal.throwIfAborted();
    return !!capabilities?.enabled;
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}
