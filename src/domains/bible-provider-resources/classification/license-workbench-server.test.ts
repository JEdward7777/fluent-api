import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';
import { makeCommandFixture } from './license-command.test-fixtures';
import { startLicenseWorkbenchServer } from './license-workbench-server';

const options = parseLicenseCommandOptions(['--source=json', '--destination=json'], true);
if (options.help) throw new Error('Expected options');
const active: Array<Awaited<ReturnType<typeof startLicenseWorkbenchServer>>> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((item) => item.close()));
});

describe('local license workbench server', () => {
  it('guards setup and mutation with exact token, Host and Origin', async () => {
    const session = await startLicenseWorkbenchServer(options.options, 0);
    active.push(session);
    const token = new URL(session.url).hash.slice(1);
    const base = `http://127.0.0.1:${session.port}`;
    const read = (headers: HeadersInit) => fetch(`${base}/api/setup`, { headers });
    expect((await read({})).status).toBe(403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(
        `${base}/api/setup`,
        { headers: { host: 'evil.example', 'x-workbench-token': token } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      ).on('error', reject);
    });
    expect(foreignHostStatus).toBe(403);
    const setup = await read({ 'x-workbench-token': token });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toMatchObject({
      source: 'json',
      destination: 'json',
      readyForInspect: true,
    });
    expect(
      (await fetch(`${base}/api/ping`, { method: 'POST', headers: { 'x-workbench-token': token } }))
        .status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/ping`, {
          method: 'POST',
          headers: { 'x-workbench-token': token, origin: 'http://evil.example' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/ping`, {
          method: 'POST',
          headers: { 'x-workbench-token': token, origin: base },
        })
      ).status
    ).toBe(200);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });

  it('applies revisioned setup and runs JSON inspection then analysis without publishing files', async () => {
    const fixture = await makeCommandFixture();
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const session = await startLicenseWorkbenchServer(fixture.options, 0);
    active.push(session);
    const token = new URL(session.url).hash.slice(1);
    const base = `http://127.0.0.1:${session.port}`;
    const headers = {
      'x-workbench-token': token,
      origin: base,
      'content-type': 'application/json',
    };
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const first = (await api('setup')).body;
      expect(JSON.stringify(first)).not.toContain(fixture.sourceBytes);
      const changed = {
        ...first,
        configurationRevision: 1,
        discardReviewedState: false,
        cacheDir: null,
      };
      delete changed.step;
      delete changed.state;
      delete changed.contentRevision;
      delete changed.readyForInspect;
      delete changed.databaseTarget;
      delete changed.inspected;
      delete changed.analysis;
      delete changed.activeOperationId;
      delete changed.latestOperation;
      const applied = await api('setup', 'POST', changed);
      expect(applied.status).toBe(200);
      expect(applied.body.configurationRevision).toBe(2);
      const stale = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers,
        body: JSON.stringify(changed),
      });
      expect(stale.status).toBe(409);
      const request = { operationId: crypto.randomUUID(), configurationRevision: 2 };
      expect((await api('inspect', 'POST', request)).status).toBe(202);
      let state;
      for (let i = 0; i < 30; i++) {
        state = (await api('setup')).body;
        if (state.state === 'inspected') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(state.state).toBe('inspected');
      expect(state.inspected.preflight.expectedUncachedRequests).toBe(0);
      expect(JSON.stringify(state)).not.toContain(fixture.sourceBytes);
      expect((await api(`operations/${request.operationId}`)).body.state).toBe('succeeded');
      expect((await api('inspect', 'POST', request)).body.state).toBe('succeeded');
      const mismatched = await fetch(`${base}/api/analysis`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      expect(mismatched.status).toBe(409);
      const analysis = { operationId: crypto.randomUUID(), configurationRevision: 2 };
      expect((await api('analysis', 'POST', analysis)).status).toBe(202);
      for (let i = 0; i < 30; i++) {
        state = (await api('setup')).body;
        if (state.state === 'reviewing') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(state.state).toBe('reviewing');
      expect(state.analysis.rows).toBe(fixture.artifact.classifications.length);
      expect(JSON.stringify(state)).not.toContain(fixture.sourceBytes);
      expect(await fixture.readOutput().catch(() => null)).toBeNull();
      const invalid = {
        ...changed,
        configurationRevision: 2,
        discardReviewedState: true,
        input: '/tmp/02b-source-does-not-exist.json',
      };
      expect((await api('setup', 'POST', invalid)).status).toBe(200);
      const missing = { operationId: crypto.randomUUID(), configurationRevision: 3 };
      expect((await api('inspect', 'POST', missing)).status).toBe(202);
      let failed;
      for (let i = 0; i < 30; i++) {
        failed = (await api(`operations/${missing.operationId}`)).body;
        if (failed.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(failed).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('not found'),
      });
      expect(failed.error).not.toContain(invalid.input);
      expect((await api('setup')).body.latestOperation.state).toBe('failed');
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      await fixture.cleanup();
    }
  });
});
