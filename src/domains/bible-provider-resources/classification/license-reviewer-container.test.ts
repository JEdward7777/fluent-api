import { readFile, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import {
  describeLicenseReportPath,
  licenseReviewerContainerArgs,
} from './license-reviewer-container';
import { startLicenseWorkbenchServer } from './license-workbench-server';

it('defaults to fixed-port web and keeps terminal launch and practice separate', () => {
  expect(licenseReviewerContainerArgs([], {})).toEqual([
    '--ui=web',
    '--port=8766',
    '--report-dir=/reports',
  ]);
  expect(licenseReviewerContainerArgs(['--source=json'], { LICENSE_REVIEWER_UI: 'cli' })).toEqual([
    '--ui=cli',
    '--report-dir=/reports',
    '--source=json',
  ]);
  expect(licenseReviewerContainerArgs(['--practice'], { LICENSE_REVIEWER_PORT: '8767' })).toEqual([
    '--ui=web',
    '--port=8767',
    '--practice',
  ]);
  expect(() => licenseReviewerContainerArgs(['--port=9500'], {})).toThrow(/container launcher/);
});

it('labels the inspected parent and the selected directory entry for overwrite confirmation', async () => {
  const container = { hostReports: 'C:\\review-output' };
  const selectedPath = '/reports/current/alias.html';
  await expect(
    describeLicenseReportPath(selectedPath, container, { parent: '/reports/approved' })
  ).resolves.toBe('Docker host path: C:\\review-output\\approved\\alias.html');
  await expect(
    describeLicenseReportPath(selectedPath, container, { parent: '/tmp/outside' })
  ).resolves.toBe(`Container path: ${selectedPath}`);
});

it('preserves loopback Host, Origin and token gates for reports in container mode', async () => {
  const fixture = await makeCommandFixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Expected test port');
  const start = () =>
    startLicenseWorkbenchServer(fixture.options, address.port, false, undefined, undefined, {});
  try {
    await expect(start()).rejects.toThrow(/in use; select another --port/);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  const session = await start();
  try {
    expect(session.server.address()).toMatchObject({ address: '0.0.0.0' });
    const launched = new URL(session.url);
    const base = launched.origin;
    const token = launched.hash.slice(1);
    const headers = {
      'x-workbench-token': token,
      origin: base,
      'content-type': 'application/json',
    };
    const api = (path: string, body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        headers,
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
    const unexpectedHost = await new Promise<number | undefined>((resolve, reject) => {
      get(base, { headers: { host: `untrusted.example:${address.port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(unexpectedHost).toBe(403);
    const initial = await (await api('setup')).json();
    for (const kind of ['inspect', 'analysis']) {
      const operationId = crypto.randomUUID();
      expect((await api(kind, { operationId, configurationRevision: 1 })).status).toBe(202);
      await expect
        .poll(async () => (await (await api(`operations/${operationId}`)).json()).state)
        .toBe('succeeded');
    }
    const current = await (await api('setup')).json();
    const revision = {
      configurationRevision: initial.configurationRevision,
      contentRevision: current.contentRevision,
    };
    const response = await api('preview', revision);
    expect(response.status).toBe(200);
    const { preview } = await response.json();
    const path = join(fixture.dir, 'output.html');
    const inspected = await api('report/inspect', {
      ...revision,
      previewToken: preview.token,
      path,
      format: 'html',
    });
    expect(inspected.status).toBe(200);
    const inspectedPlan = await inspected.json();
    expect(inspectedPlan).toMatchObject({ displayPath: `Container path: ${path}`, existed: false });
    const planId = inspectedPlan.id;
    const operationId = crypto.randomUUID();
    const exported = await api('report/export', { planId, operationId, agreeToOverwrite: false });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({
      operationId,
      displayPath: `Container path: ${path}`,
      filename: 'output.html',
    });
    const rendered = await readFile(path, 'utf8');
    await writeFile(path, 'Report file changed after export');
    expect(await (await api(`report/${operationId}`)).text()).toBe(rendered);
    expect((await api(`report/${encodeURIComponent(fixture.input)}`)).status).toBe(404);
    expect((await fetch(`${base}/api/report/${operationId}`)).status).toBe(403);
    const open = (origin: string | undefined, submittedToken: string) =>
      fetch(`${base}/report-view`, {
        method: 'POST',
        headers: origin ? { origin } : {},
        body: new URLSearchParams({ id: operationId, token: submittedToken }),
      });
    expect((await open(undefined, token)).status).toBe(403);
    expect((await open('null', token)).status).toBe(403);
    expect((await open('http://untrusted.example', token)).status).toBe(403);
    expect((await open(base, 'invalid')).status).toBe(403);
    const opened = await open(base, token);
    expect(opened.status).toBe(200);
    expect(opened.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(opened.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await opened.text()).toBe(rendered);
    expect((await fetch(base)).headers.get('referrer-policy')).toBe('same-origin');
  } finally {
    await session.close();
    await fixture.cleanup();
  }
});
