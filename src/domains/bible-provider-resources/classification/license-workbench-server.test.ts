import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';
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
      readyForInspect: false,
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
});
