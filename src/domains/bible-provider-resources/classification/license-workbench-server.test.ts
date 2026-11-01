import { readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createLicenseArtifact, serializeLicenseArtifact } from '../license-artifact';
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
  it('allocates practice scratch only at Inspect and rejects forged real targets and attestation', async () => {
    const fixture = await makeCommandFixture();
    const session = await startLicenseWorkbenchServer(
      { ...fixture.options, input: fixture.input },
      0,
      true
    );
    active.push(session);
    const base = `http://127.0.0.1:${session.port}`;
    const headers = {
      'x-workbench-token': new URL(session.url).hash.slice(1),
      origin: base,
      'content-type': 'application/json',
    };
    const call = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const before = await (await call('setup')).json();
      expect(before.practice).toBe(true);
      expect(before.scratch).toBeNull();
      const forged = {
        configurationRevision: before.configurationRevision,
        discardReviewedState: false,
        source: 'json',
        destination: 'database',
        input: fixture.input,
        output: fixture.output,
        model: before.model,
        sampleCount: before.sampleCount,
        force: false,
        noCache: false,
        cacheDir: before.cacheDir,
        reportFormats: before.reportFormats,
        reportDir: before.reportDir,
        preserveExistingNonUnknowns: false,
      };
      expect((await call('setup', 'POST', forged)).status).toBe(409);
      expect((await call('setup', 'POST', { ...forged, destination: 'json' })).status).toBe(409);
      expect((await call('practice/attest', 'POST', { reviewedBy: 'Forged' })).status).toBe(404);
      expect(
        (
          await call('inspect', 'POST', {
            operationId: crypto.randomUUID(),
            configurationRevision: 1,
          })
        ).status
      ).toBe(202);
      let after = await (await call('setup')).json();
      for (let attempt = 0; attempt < 30 && after.latestOperation?.state === 'running'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        after = await (await call('setup')).json();
      }
      expect(after.state).toBe('inspected');
      expect(after.scratch).toContain('fluent-license-practice-');
      expect(await readFile(fixture.input, 'utf8')).toBe(fixture.sourceBytes);
      await rm(after.scratch, { recursive: true, force: true });
    } finally {
      await fixture.cleanup();
    }
  });
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
    const extended = structuredClone(fixture.artifact);
    Object.assign(extended.classifications[0], {
      id: 'extension-row-id',
      configurationRevision: 999,
      contentRevision: 999,
    });
    await writeFile(fixture.input, serializeLicenseArtifact(createLicenseArtifact(extended)).bytes);
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
      const text = await response.text();
      return { status: response.status, body: response.ok ? JSON.parse(text) : text };
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
      delete changed.launchId;
      delete changed.state;
      delete changed.contentRevision;
      delete changed.readyForInspect;
      delete changed.databaseTarget;
      delete changed.inspected;
      delete changed.analysis;
      delete changed.activeOperationId;
      delete changed.latestOperation;
      delete changed.practice;
      delete changed.scratch;
      delete changed.originalHash;
      delete changed.selectedSource;
      delete changed.practiceRows;
      delete changed.preview;
      delete changed.saveOutcome;
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
      const list = (await api('review?status=all&page=1')).body;
      const reserved = fixture.artifact.classifications.find(
        (candidate) => candidate.rule?.id === 'all-rights-reserved'
      )!;
      const rowId = list.rows.find(
        (candidate: { normalizedText: string }) =>
          candidate.normalizedText === reserved.normalizedText
      ).id;
      const row = (await api(`review/${rowId}`)).body;
      expect(row.id).toBe(rowId);
      expect(row.configurationRevision).toBe(state.configurationRevision);
      expect(row.contentRevision).toBe(state.contentRevision);
      expect(row.id).not.toBe('extension-row-id');
      const edit = {
        id: row.id,
        configurationRevision: state.configurationRevision,
        contentRevision: state.contentRevision,
        acknowledgeWarning: false,
        edit: {
          kind: 'disposition',
          normalizedText: row.normalizedText,
          status: 'allowed',
          reason: 'The reviewer accepts this exception.',
        },
      };
      expect((await api('review/edit', 'POST', edit)).status).toBe(409);
      expect((await api('setup')).body.contentRevision).toBe(state.contentRevision);
      expect((await api(`review/${row.id}`)).body.automaticDecision).toBeUndefined();
      const acknowledged = { ...edit, acknowledgeWarning: true };
      expect(
        (await api('review/edit', 'POST', acknowledged)).body.setup.contentRevision
      ).toBeGreaterThan(state.contentRevision);
      expect((await api('review/edit', 'POST', acknowledged)).status).toBe(409);
      expect(
        (
          await api('review/edit', 'POST', {
            ...acknowledged,
            contentRevision: state.contentRevision + 1,
            id: '0'.repeat(64),
          })
        ).status
      ).toBe(409);
      expect((await api(`review/${row.id}`)).body).toMatchObject({
        source: 'manual',
        status: 'allowed',
        rule: row.rule,
        automaticDecision: { source: 'rule', status: 'forbidden' },
      });
      const nextRevision = (await api('setup')).body.contentRevision;
      const separateNote = {
        ...acknowledged,
        contentRevision: nextRevision,
        edit: {
          ...edit.edit,
          status: 'unknown',
          reason: 'Distinct decision rationale.',
          unknownNote: 'Distinct retained unknown note.',
        },
      };
      expect((await api('review/edit', 'POST', separateNote)).status).toBe(200);
      expect((await api(`review/${row.id}`)).body).toMatchObject({
        status: 'unknown',
        rationale: 'Distinct decision rationale.',
        rowNote: 'Distinct retained unknown note.',
        automaticDecision: { source: 'rule', status: 'forbidden' },
      });
      expect(
        (
          await api('review/edit', 'POST', {
            ...separateNote,
            contentRevision: nextRevision + 1,
            edit: { ...separateNote.edit, status: 'allowed' },
          })
        ).status
      ).toBe(409);
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
