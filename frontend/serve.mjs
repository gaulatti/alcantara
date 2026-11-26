// Serves the static client build for the production image (gaulatti/alcantara#741 follow-up). The app is
// built with `ssr: false` (react-router.config.ts), so `react-router build` emits only build/client and there is no
// server bundle for react-router-serve to run. This is a dependency-free static server with SPA fallback to
// index.html. It serves the directory the build writes, relative to the frontend directory it runs from.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve('build/client');
const port = Number(process.env.PORT ?? 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function fileFor(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const stat = statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory() && statSync(join(candidate, 'index.html')).isFile()) return join(candidate, 'index.html');
  } catch {
    // Not a file: fall through to the SPA shell.
  }
  return null;
}

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  let file = fileFor(path);
  // Unknown routes get the SPA shell, so client routes survive a reload. A missing asset is a real 404.
  if (!file) {
    if (extname(path) && path.startsWith('/assets/')) {
      response.writeHead(404).end();
      return;
    }
    file = join(root, 'index.html');
  }
  const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
  // Hashed assets never change, so they cache forever; the shell must revalidate so a deploy is seen at once.
  headers['Cache-Control'] = file.startsWith(join(root, 'assets') + sep)
    ? 'public,max-age=31536000,immutable'
    : 'no-cache,no-store,must-revalidate';
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end();
  });
  stream.once('open', () => {
    response.writeHead(200, headers);
    stream.pipe(response);
  });
}).listen(port, () => {
  console.log(`serving ${root} on ${port}`);
});
