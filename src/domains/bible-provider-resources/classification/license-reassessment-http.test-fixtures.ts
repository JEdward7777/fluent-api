import { expect } from 'vitest';

import type { makeCommandFixture } from './license-command.test-fixtures';

import { parseLicenseWorkbenchLaunch } from './license-workbench-launch';
import { startLicenseWorkbenchServer } from './license-workbench-server';

export async function start(f: Awaited<ReturnType<typeof makeCommandFixture>>, ...flags: string[]) {
  const launch = parseLicenseWorkbenchLaunch(
    [
      '--ui=web',
      '--source=json',
      '--destination=json',
      `--input=${f.input}`,
      `--output=${f.output}`,
      `--cache-dir=${f.options.cacheDir}`,
      ...flags,
    ],
    false
  );
  if (launch.kind !== 'web') throw new Error('Expected web launch');
  const server = await startLicenseWorkbenchServer(
    launch.options,
    0,
    false,
    undefined,
    f.dependencies
  );
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (route: string, body?: object | null) => {
    const response = await fetch(`${base}/api/${route}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        origin: base,
        'x-workbench-token': new URL(server.url).hash.slice(1),
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: response.ok ? await response.json() : await response.text(),
    };
  };
  const operate = async (kind: string) => {
    const operationId = crypto.randomUUID();
    expect((await api(kind, { operationId, configurationRevision: 1 })).status).toBe(202);
    await expect
      .poll(async () => (await api(`operations/${operationId}`)).body.state)
      .toBe('succeeded');
    return (await api('setup')).body;
  };
  return { api, operate, close: server.close };
}
