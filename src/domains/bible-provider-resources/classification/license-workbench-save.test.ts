import { Buffer } from 'node:buffer';
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
    const priorKey = process.env.GOOGLE_AI_API_KEY;
    process.env.GOOGLE_AI_API_KEY = 'offline-test-key';
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
      expect(
        (await api('preview', 'POST', { ...revision, expectedPreviewToken: null })).status
      ).toBe(409);
      expect((await api(`changes/${crypto.randomUUID()}`)).status).toBe(409);
      const changes = await (await api(`changes/${preview.token}`)).json();
      expect(changes.previewToken).toBe(preview.token);
      expect(changes.destinations).toHaveLength(1);
      expect(preview.incomplete).toBe(true);
      const save = {
        previewToken: preview.token,
        ...revision,
        operationId: crypto.randomUUID(),
        agreeToReplace: false,
      };
      const stale = { ...save, previewToken: crypto.randomUUID() };
      expect((await api('save', 'POST', stale)).status).toBe(409);
      expect((await api(`operations/${stale.operationId}`)).status).toBe(404);
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
      const planned = changes.destinations[0];
      expect(planned.kind).toBe('JSON');
      expect(planned.wholeFileHash).toBe(operation.result.wholeFileHash);
      expect(
        planned.records
          .filter((row: { group: string }) => row.group === 'Classification')
          .map((row: { after: unknown }) => row.after)
      ).toEqual(JSON.parse(bytes).classifications);
      expect(bytes).toContain('classifications');
      expect(operation.result.json.artifactBytes).toBe(Buffer.byteLength(bytes));
      const current = await api(`current-report/${preview.token}/markdown`);
      expect(current.status).toBe(200);
      expect(await current.text()).toContain('#');
      expect((await api(`current-report/${crypto.randomUUID()}/markdown`)).status).toBe(409);
      expect((await api('save', 'POST', retry)).status).toBe(202);
      expect(await readFile(fixture.output, 'utf8')).toBe(bytes);
      expect(
        (await api('save', 'POST', { ...retry, operationId: crypto.randomUUID() })).status
      ).toBe(409);
    } finally {
      if (priorKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = priorKey;
      await fixture.cleanup();
    }
  });

  it('refuses an externally changed output and clears the stale preview', async () => {
    const fixture = await makeCommandFixture(false);
    const priorKey = process.env.GOOGLE_AI_API_KEY;
    process.env.GOOGLE_AI_API_KEY = 'offline-test-key';
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
      const rows = await (await api('review?status=all&page=1')).json();
      const row = rows.rows[0];
      const edit = await api('review/edit', 'POST', {
        id: row.id,
        configurationRevision: 1,
        contentRevision: state.contentRevision,
        acknowledgeWarning: true,
        edit: {
          kind: 'disposition',
          normalizedText: row.normalizedText,
          status: 'unknown',
          reason: 'Pending destination retry.',
          reviewedBy: 'Fixture reviewer',
          unknownNote: 'Checked the notice.',
        },
      });
      expect(edit.status).toBe(200);
      const revision = {
        configurationRevision: 1,
        contentRevision: (await edit.json()).setup.contentRevision,
      };
      const { preview } = await (await api('preview', 'POST', revision)).json();
      await writeFile(fixture.output, 'external edit');
      const saveId = crypto.randomUUID();
      expect(
        (
          await api('save', 'POST', {
            previewToken: preview.token,
            ...revision,
            operationId: saveId,
            agreeToReplace: false,
          })
        ).status
      ).toBe(202);
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await (await api(`operations/${saveId}`)).json()).state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const after = await (await api('setup')).json();
      expect(after.state).toBe('reviewing');
      expect(after.contentRevision).toBe(revision.contentRevision);
      expect(await (await api(`review/${row.id}`)).json()).toMatchObject({
        reviewedBy: 'Fixture reviewer',
        rationale: 'Pending destination retry.',
      });
      expect(after.preview).toBeNull();
      expect(await readFile(fixture.output, 'utf8')).toBe('external edit');
    } finally {
      if (priorKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = priorKey;
      await fixture.cleanup();
    }
  });
});
