import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { startLicenseWorkbenchServer } from './license-workbench-server';

const active: Array<Awaited<ReturnType<typeof startLicenseWorkbenchServer>>> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((server) => server.close()));
});

describe('workbench Save operation', () => {
  it('saves incomplete synthetic JSON once and exposes the known result across reloads', async () => {
    const fixture = await makeCommandFixture(false);
    const priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const server = await startLicenseWorkbenchServer(fixture.options, 0);
    active.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      origin: base,
      'content-type': 'application/json',
      'x-workbench-token': new URL(server.url).hash.slice(1),
    };
    const api = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      for (const [kind, expected] of [
        ['inspect', 'inspected'],
        ['analysis', 'reviewing'],
      ]) {
        expect(
          (await api(kind, 'POST', { operationId: crypto.randomUUID(), configurationRevision: 1 }))
            .status
        ).toBe(202);
        for (let attempt = 0; attempt < 50; attempt++) {
          if ((await (await api('setup')).json()).state === expected) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const state = await (await api('setup')).json();
      const revision = {
        configurationRevision: state.configurationRevision,
        contentRevision: state.contentRevision,
      };
      expect((await api('preview', 'POST', revision)).status).toBe(200);
      const preview = (await (await api('setup')).json()).preview;
      expect(preview.incomplete).toBe(true);
      const save = { ...revision, operationId: crypto.randomUUID(), agreeToReplace: false };
      expect((await api('save', 'POST', { ...save, agreeToReplace: true })).status).toBe(202);
      // A matching ID with changed fields cannot reinterpret the first operation.
      expect((await api('save', 'POST', save)).status).toBe(409);
      const retry = { ...save, agreeToReplace: true };
      expect((await api('save', 'POST', retry)).status).toBe(202);
      let operation = await (await api(`operations/${retry.operationId}`)).json();
      for (let attempt = 0; attempt < 50 && operation.state === 'running'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        operation = await (await api(`operations/${retry.operationId}`)).json();
      }
      expect(operation.state).toBe('succeeded');
      expect(operation.result).toMatchObject({
        wholeFileHash: preview.wholeFileHash,
        incomplete: true,
        policy: null,
        targets: [{ path: fixture.output, hash: preview.wholeFileHash }],
      });
      expect((await (await api('setup')).json()).saveOutcome).toEqual(operation);
      const bytes = await readFile(fixture.output, 'utf8');
      expect(bytes).toContain('classifications');
      expect((await api('save', 'POST', retry)).status).toBe(202);
      expect(await readFile(fixture.output, 'utf8')).toBe(bytes);
      expect(
        (await api('save', 'POST', { ...retry, operationId: crypto.randomUUID() })).status
      ).toBe(409);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      await fixture.cleanup();
    }
  });

  it('refuses an externally changed output and clears the stale preview', async () => {
    const fixture = await makeCommandFixture(false);
    const priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const server = await startLicenseWorkbenchServer(fixture.options, 0);
    active.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      origin: base,
      'content-type': 'application/json',
      'x-workbench-token': new URL(server.url).hash.slice(1),
    };
    const api = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      for (const kind of ['inspect', 'analysis']) {
        await api(kind, 'POST', { operationId: crypto.randomUUID(), configurationRevision: 1 });
        for (let attempt = 0; attempt < 50; attempt++) {
          const state = (await (await api('setup')).json()).state;
          if (state === (kind === 'inspect' ? 'inspected' : 'reviewing')) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const state = await (await api('setup')).json();
      const revision = { configurationRevision: 1, contentRevision: state.contentRevision };
      await api('preview', 'POST', revision);
      await writeFile(fixture.output, 'external edit');
      const saveId = crypto.randomUUID();
      expect(
        (await api('save', 'POST', { ...revision, operationId: saveId, agreeToReplace: false }))
          .status
      ).toBe(202);
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await (await api(`operations/${saveId}`)).json()).state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const after = await (await api('setup')).json();
      expect(after.state).toBe('configuring');
      expect(after.preview).toBeNull();
      expect(await readFile(fixture.output, 'utf8')).toBe('external edit');
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      await fixture.cleanup();
    }
  });
});
