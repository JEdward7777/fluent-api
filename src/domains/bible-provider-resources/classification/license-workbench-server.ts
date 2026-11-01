import type { Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LicenseCommandOptions } from './license-command-options';

const assetDirectory = join(dirname(fileURLToPath(import.meta.url)), 'assets');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
] as const);

function sameToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const received = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return received.length === secret.length && timingSafeEqual(received, secret);
}

function createLicenseWorkbenchApp(
  options: LicenseCommandOptions,
  getPort: () => number,
  token: string
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (host !== `localhost:${getPort()}` && host !== `127.0.0.1:${getPort()}`)
      return c.text('Invalid local Host', 403);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
    );
    if (c.req.path.startsWith('/api/')) {
      if (!sameToken(c.req.header('x-workbench-token'), token))
        return c.text('Session token required', 403);
      if (c.req.method !== 'GET' && c.req.header('origin') !== `http://${host}`)
        return c.text('Local Origin required', 403);
    }
    await next();
  });
  app.get('/api/setup', (c) =>
    c.json({
      step: 'Choose inputs',
      state: 'configuring',
      readyForInspect: false,
      source: options.source ?? null,
      destination: options.destination ?? null,
      input: options.input,
      output: options.output,
      sampleCount: options.sampleCount,
      model: options.model,
      force: options.force,
      noCache: options.noCache,
      preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
    })
  );
  app.get('/api/ping', (c) => c.json({ ok: true }));
  app.post('/api/ping', (c) => c.json({ ok: true }));
  app.get('*', async (c) => {
    const asset = assets.get(c.req.path as '/' | '/app.css' | '/app.js');
    if (!asset) return c.text('Not found', 404);
    const [name, contentType] = asset;
    c.header('Content-Type', contentType);
    return c.body(new Uint8Array(await readFile(join(assetDirectory, name))));
  });
  return app;
}

export async function startLicenseWorkbenchServer(
  options: LicenseCommandOptions,
  requestedPort: number
) {
  const token = randomBytes(32).toString('base64url');
  let selectedPort = requestedPort;
  const listen = () =>
    new Promise<Server>((resolve, reject) => {
      const app = createLicenseWorkbenchApp(options, () => selectedPort, token);
      const listener = getRequestListener(app.fetch);
      const candidate = createServer((request, response) => {
        if (
          request.headers.host !== `localhost:${selectedPort}` &&
          request.headers.host !== `127.0.0.1:${selectedPort}`
        ) {
          response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          response.end('Invalid local Host');
          return;
        }
        void listener(request, response);
      });
      candidate.once('error', reject);
      candidate.listen(requestedPort, '127.0.0.1', () => {
        const address = candidate.address();
        if (!address || typeof address === 'string')
          return reject(new Error('Unable to allocate a local port'));
        selectedPort = address.port;
        resolve(candidate);
      });
    });
  let server: Server;
  try {
    server = await listen();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')
      throw new Error(`Local port ${requestedPort} is in use; select another --port`);
    throw error;
  }
  return {
    server,
    port: selectedPort,
    url: `http://127.0.0.1:${selectedPort}/#${token}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}
