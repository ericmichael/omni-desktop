import { createServer } from 'net';

/**
 * Ask the kernel for an unused TCP port on 127.0.0.1 by binding port 0
 * and reading back the assigned port. Closes the server immediately and
 * returns the number. There is a tiny race window between close and the
 * caller binding it again, which is acceptable for local subprocesses.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address && 'port' in address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to allocate port')));
      }
    });
  });
}
