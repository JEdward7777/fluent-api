import type { Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { LicenseCommandOptions } from './license-command-options';

import { operationSchema, setupSchema } from './license-workbench-schema';
import { LicenseWorkbenchSession } from './license-workbench-session';

const assetDirectory = join(dirname(fileURLToPath(import.meta.url)), 'assets');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/review.js', ['review.js', 'text/javascript; charset=utf-8']],
  ['/save.js', ['save.js', 'text/javascript; charset=utf-8']],
  ['/preview-text.js', ['preview-text.js', 'text/javascript; charset=utf-8']],
] as const);

function sameToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const received = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return received.length === secret.length && timingSafeEqual(received, secret);
}

function createLicenseWorkbenchApp(
  session: LicenseWorkbenchSession,
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
  app.get('/api/setup', (c) => c.json(session.visible));
  const reviewQuerySchema = z.object({
    search: z.string().max(500).default(''),
    status: z.enum(['all', 'allowed', 'forbidden', 'unknown']).default('all'),
    source: z.enum(['all', 'table', 'rule', 'gemini', 'manual']).default('all'),
    page: z.coerce.number().int().positive().default(1),
  });
  app.get('/api/review', (c) => {
    const parsed = reviewQuerySchema.safeParse({
      search: c.req.query('search'),
      status: c.req.query('status'),
      source: c.req.query('source'),
      page: c.req.query('page'),
    });
    if (!parsed.success) return c.text('Invalid review query', 400);
    try {
      return c.json(session.listReview(parsed.data));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Review unavailable', 409);
    }
  });
  app.get('/api/review/:id', (c) => {
    try {
      return c.json(session.reviewDetail(c.req.param('id')));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Review unavailable', 404);
    }
  });
  app.get('/api/operations/:id', (c) => {
    const operation = session.operation(c.req.param('id'));
    return operation ? c.json(operation) : c.text('Unknown operation', 404);
  });
  app.post('/api/setup', async (c) => {
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid setup fields', 400);
    try {
      return c.json(await session.configure(parsed.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return c.text(
        message.includes('revision') ||
          message.includes('discard') ||
          message.includes('Cannot configure')
          ? message
          : 'Could not apply settings; check server configuration',
        409
      );
    }
  });
  for (const kind of ['inspect', 'analysis'] as const) {
    app.post(`/api/${kind}`, async (c) => {
      const parsed = operationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.text('Invalid operation fields', 400);
      try {
        return c.json(session.start(kind, parsed.data), 202);
      } catch (error) {
        return c.text(error instanceof Error ? error.message : 'Operation failed', 409);
      }
    });
  }
  app.post('/api/stop', (c) => {
    // Stop has no configuration or path fields to override.
    if (c.req.header('content-length') && c.req.header('content-length') !== '0')
      return c.text('Stop does not accept a request body', 400);
    try {
      session.stop();
      return c.json({ stopped: true });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Stop failed', 409);
    }
  });
  const revisionSchema = z
    .object({
      configurationRevision: z.number().int().positive(),
      contentRevision: z.number().int().positive(),
    })
    .strict();
  app.post('/api/review/edit', async (c) => {
    const parsed = revisionSchema
      .extend({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        acknowledgeWarning: z.boolean(),
        edit: z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('disposition'),
              normalizedText: z.string(),
              status: z.enum(['allowed', 'forbidden', 'unknown']),
              reason: z.string().trim().min(1),
              unknownNote: z.string().trim().min(1).optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal('unknown-note'),
              normalizedText: z.string(),
              note: z.string().trim().min(1),
            })
            .strict(),
        ]),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid review edit', 400);
    try {
      const result = session.editReview(parsed.data);
      return c.json({ setup: session.visible, warning: result.warning });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Edit failed', 409);
    }
  });
  app.post('/api/practice/preview', async (c) => {
    const parsed = revisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid practice preview', 400);
    try {
      await session.previewPractice(parsed.data.configurationRevision, parsed.data.contentRevision);
      return c.json(session.visible);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Preview failed', 409);
    }
  });
  app.post('/api/preview', async (c) => {
    const parsed = revisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid preview revision', 400);
    try {
      await session.preview(parsed.data.configurationRevision, parsed.data.contentRevision);
      return c.json(session.visible);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Preview failed', 409);
    }
  });
  app.post('/api/attest', async (c) => {
    const parsed = revisionSchema
      .extend({
        reviewContentHash: z.string().regex(/^[a-f0-9]{64}$/),
        reviewedBy: z.string().trim().min(1).max(200),
        reviewReason: z.string().trim().min(1).max(2000),
        responsibility: z.literal(true),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid attestation fields', 400);
    try {
      session.attest(parsed.data);
      return c.json(session.visible);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Attestation failed', 409);
    }
  });
  app.post('/api/report/inspect', async (c) => {
    const parsed = revisionSchema
      .extend({
        format: z.enum(['html', 'markdown']),
        path: z.string().trim().min(1).max(4096),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid report target', 400);
    try {
      return c.json(await session.inspectReport(parsed.data));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Report inspection failed', 409);
    }
  });
  app.post('/api/report/export', async (c) => {
    const parsed = z
      .object({
        planId: z.string().uuid(),
        operationId: z.string().uuid(),
        agreeToOverwrite: z.boolean(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid report export', 400);
    try {
      return c.json(await session.exportReport(parsed.data));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Report export failed', 409);
    }
  });
  app.post('/api/practice/save', async (c) => {
    const parsed = revisionSchema
      .extend({ operationId: z.string().uuid() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid practice save', 400);
    try {
      return c.json(await session.savePractice(parsed.data), 202);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Save failed', 409);
    }
  });
  app.post('/api/save', async (c) => {
    const parsed = revisionSchema
      .extend({ operationId: z.string().uuid(), agreeToReplace: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid Save fields', 400);
    try {
      if (session.visible.practice) return c.text('Practice cannot use normal Save', 409);
      return c.json(session.save(parsed.data), 202);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Save failed', 409);
    }
  });
  app.get('/api/ping', (c) => c.json({ ok: true }));
  app.post('/api/ping', (c) => c.json({ ok: true }));
  app.get('*', async (c) => {
    const asset = assets.get(
      c.req.path as '/' | '/app.css' | '/app.js' | '/review.js' | '/save.js' | '/preview-text.js'
    );
    if (!asset) return c.text('Not found', 404);
    const [name, contentType] = asset;
    c.header('Content-Type', contentType);
    return c.body(new Uint8Array(await readFile(join(assetDirectory, name))));
  });
  return app;
}

export async function startLicenseWorkbenchServer(
  options: LicenseCommandOptions,
  requestedPort: number,
  practice = false
) {
  const token = randomBytes(32).toString('base64url');
  const session = new LicenseWorkbenchSession(options, practice);
  let selectedPort = requestedPort;
  const listen = () =>
    new Promise<Server>((resolve, reject) => {
      const app = createLicenseWorkbenchApp(session, () => selectedPort, token);
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
    close: async () => {
      await session.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
