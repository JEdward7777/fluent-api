import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { startLicenseWorkbenchServer } from './license-workbench-server';

const active: Array<Awaited<ReturnType<typeof startLicenseWorkbenchServer>>> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((item) => item.close()));
});

describe('local license preview, attestation and report export', () => {
  it('hides inspected source details after detected preview drift', async () => {
    const fixture = await makeCommandFixture(false);
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const session = await startLicenseWorkbenchServer(fixture.options, 0);
    active.push(session);
    const base = `http://127.0.0.1:${session.port}`;
    const headers = {
      'x-workbench-token': new URL(session.url).hash.slice(1),
      origin: base,
      'content-type': 'application/json',
    };
    const api = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      for (const [kind, target] of [
        ['inspect', 'inspected'],
        ['analysis', 'reviewing'],
      ]) {
        await api(kind, 'POST', { operationId: crypto.randomUUID(), configurationRevision: 1 });
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await (await api('setup')).json()).state === target) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const before = await (await api('setup')).json();
      expect(before.inspected.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(fixture.input, `${fixture.sourceBytes} `);
      expect(
        (
          await api('preview', 'POST', {
            configurationRevision: 1,
            contentRevision: before.contentRevision,
          })
        ).status
      ).toBe(409);
      const after = await (await api('setup')).json();
      expect(after.state).toBe('configuring');
      expect(after.inspected).toBeNull();
      expect(after.preview).toBeNull();
      expect(after.analysis).toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      await fixture.cleanup();
    }
  });
  it('previews exact synthetic JSON, attests only its hash, and exports only an inspected report', async () => {
    const fixture = await makeCommandFixture(false);
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const session = await startLicenseWorkbenchServer(fixture.options, 0);
    active.push(session);
    const base = `http://127.0.0.1:${session.port}`;
    const headers = {
      'x-workbench-token': new URL(session.url).hash.slice(1),
      origin: base,
      'content-type': 'application/json',
    };
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${base}/api/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.text() };
    };
    try {
      const first = JSON.parse((await api('setup')).body);
      const settingKeys = [
        'source',
        'destination',
        'input',
        'output',
        'model',
        'sampleCount',
        'force',
        'noCache',
        'cacheDir',
        'reportFormats',
        'reportDir',
        'preserveExistingNonUnknowns',
      ];
      const settings = Object.fromEntries(settingKeys.map((key) => [key, first[key]]));
      expect(
        (
          await api('setup', 'POST', {
            ...settings,
            configurationRevision: 1,
            discardReviewedState: false,
          })
        ).status
      ).toBe(200);
      for (const kind of ['inspect', 'analysis']) {
        expect(
          (await api(kind, 'POST', { operationId: crypto.randomUUID(), configurationRevision: 2 }))
            .status
        ).toBe(202);
        for (let attempt = 0; attempt < 30; attempt++) {
          const state = JSON.parse((await api('setup')).body);
          if (state.state === (kind === 'inspect' ? 'inspected' : 'reviewing')) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const state = JSON.parse((await api('setup')).body);
      const revision = { configurationRevision: 2, contentRevision: state.contentRevision };
      expect((await api('attest', 'POST', { ...revision })).status).toBe(400);
      const previewResponse = await api('preview', 'POST', revision);
      expect(previewResponse.status).toBe(200);
      const preview = JSON.parse(previewResponse.body).preview;
      expect(preview.configurationRevision).toBe(2);
      expect(preview.incomplete).toBe(true);
      expect(preview.targets).toEqual([
        { path: fixture.output, role: 'output', existed: false, previousHash: null },
      ]);
      expect(preview.policy).toBeNull();
      expect(
        (await api('report/inspect', 'POST', { ...revision, format: 'html', path: fixture.input }))
          .status
      ).toBe(409);
      const report = JSON.parse(
        (
          await api('report/inspect', 'POST', {
            ...revision,
            format: 'markdown',
            path: `${fixture.dir}/impact.md`,
          })
        ).body
      );
      expect(report.existed).toBe(false);
      expect(report.configurationRevision).toBe(2);
      const reportOperationId = crypto.randomUUID();
      const exported = await api('report/export', 'POST', {
        planId: report.id,
        operationId: reportOperationId,
        agreeToOverwrite: false,
      });
      expect(exported.status).toBe(200);
      expect(JSON.parse(exported.body).configurationRevision).toBe(2);
      const attestation = {
        ...revision,
        reviewContentHash: preview.reviewContentHash,
        reviewedBy: 'Fixture reviewer',
        reviewReason: 'I inspected this synthetic evidence.',
        responsibility: true,
      };
      expect((await api('attest', 'POST', { ...attestation, responsibility: false })).status).toBe(
        400
      );
      expect(
        (await api('attest', 'POST', { ...attestation, responsibility: undefined })).status
      ).toBe(400);
      const unsigned = JSON.parse((await api('setup')).body);
      expect(unsigned.contentRevision).toBe(revision.contentRevision);
      expect(unsigned.preview.incomplete).toBe(true);
      expect(
        (await api('attest', 'POST', { ...attestation, reviewContentHash: '0'.repeat(64) })).status
      ).toBe(409);
      expect((await api('attest', 'POST', attestation)).status).toBe(200);
      const after = JSON.parse((await api('setup')).body);
      expect(after.preview).toBeNull();
      expect(after.contentRevision).toBeGreaterThan(revision.contentRevision);
      expect(
        (
          await api('report/export', 'POST', {
            planId: report.id,
            operationId: reportOperationId,
            agreeToOverwrite: false,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await api('report/export', 'POST', {
            planId: report.id,
            operationId: crypto.randomUUID(),
            agreeToOverwrite: false,
          })
        ).status
      ).toBe(409);
      expect(
        (
          await api('preview', 'POST', {
            configurationRevision: 2,
            contentRevision: after.contentRevision,
          })
        ).status
      ).toBe(200);
      expect(JSON.parse((await api('setup')).body).preview.incomplete).toBe(false);
      expect(await fixture.readOutput().catch(() => null)).toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      await fixture.cleanup();
    }
  });
});
