import type { Server } from 'node:http';
import type { App } from 'supertest/types';

// supertest starts an idle server with `server.listen(0)`, which binds every
// address, and then connects to 127.0.0.1:<port>. On macOS the kernel can hand
// that listener a port that another process already holds on 127.0.0.1 alone
// (a browser, a dev server, an agent's local socket), and the request then
// reaches that other process: a 404, a reset, or a reply that is not ours
// (gaulatti/alcantara#310). Listening on 127.0.0.1 first removes the clash: the
// kernel will not offer a port taken on that address, and a wildcard listener
// elsewhere loses to the more specific one. supertest sees a listening server,
// uses its port, and leaves closing it to the app (`app.close()`).
export async function listenOnLoopback(target: App): Promise<void> {
  // The Nest apps under test are plain http servers; supertest's `App` type also allows a handler or a URL.
  const server = target as Server;
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
