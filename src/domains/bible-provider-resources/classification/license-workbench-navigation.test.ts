import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { startLicenseWorkbenchServer } from './license-workbench-server';

it('navigates the entire effective filtered inventory and replays the acknowledged next row', async () => {
  const fixture = await makeCommandFixture();
  const server = await startLicenseWorkbenchServer(
    fixture.options,
    0,
    false,
    undefined,
    fixture.dependencies
  );
  const base = new URL(server.url).origin;
  const call = (route: string, body?: object) =>
    fetch(`${base}/api/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: base,
        'x-workbench-token': new URL(server.url).hash.slice(1),
        'content-type': 'application/json',
      },
      body: body && JSON.stringify(body),
    });
  const get = async (route: string) => (await call(route)).json();
  try {
    expect(
      (await call('inspect', { operationId: crypto.randomUUID(), configurationRevision: 1 })).status
    ).toBe(202);
    await expect.poll(async () => (await get('setup')).state).toBe('inspected');
    const list = await get('review');
    const [first, middle, last] = list.rows;
    const query = { pageSize: 1, page: 3 };
    const body = (id: string, revision: number) => ({
      id,
      epoch: list.epoch,
      contentRevision: revision,
      mutationId: crypto.randomUUID(),
    });
    const post = async (payload: object) => {
      const response = await call('review/draft', payload);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await get('review?pageSize=1&page=99')).toMatchObject({
      page: 3,
      total: 3,
      rangeStart: 3,
      rangeEnd: 3,
      remaining: 3,
      rows: [{ id: last.id }],
    });
    expect(await get(`review/${middle.id}?pageSize=1`)).toMatchObject({
      remaining: 3,
      contentRevision: list.contentRevision,
      navigation: { previousId: first.id, nextId: last.id },
    });
    const evictFirst = await post({
      ...body(first.id, list.contentRevision),
      kind: 'mark-next',
      query: { reviewState: 'unreviewed', pageSize: 1 },
    });
    expect(evictFirst.navigation).toMatchObject({
      remaining: 1,
      total: 1,
      nextEligibleId: last.id,
    });
    const undo = await post({ ...body(first.id, evictFirst.contentRevision), kind: 'revert' });
    const cmd = { ...body(last.id, undo.contentRevision), kind: 'mark-next', query };
    const wrapped = await post(cmd);
    expect(wrapped.navigation).toMatchObject({ remaining: 2, nextEligibleId: first.id });
    const changed = await post({
      ...body(first.id, wrapped.contentRevision),
      kind: 'patch',
      status: 'allowed',
      reviewComment: 'Find this draft',
      touched: true,
    });
    expect(
      await get('review?search=find%20this&source=manual&status=allowed&reviewState=human_reviewed')
    ).toMatchObject({
      remaining: 0,
      total: 1,
      rows: [{ id: first.id, pending: true }],
    });
    expect(await post(cmd)).toEqual(wrapped);
    expect((await call('review/draft', { ...cmd, query: { ...query, page: 2 } })).status).toBe(409);
    const filtered = { reviewState: 'llm_reviewed', pageSize: 1, page: 3 };
    const exhausted = await post({
      ...body(middle.id, changed.contentRevision),
      kind: 'mark-next',
      query: filtered,
    });
    expect(exhausted.navigation).toEqual({ total: 0, page: 1, remaining: 0, nextEligibleId: null });
    expect(await get('review?reviewState=llm_reviewed&page=9')).toMatchObject({
      total: 0,
      page: 1,
      rangeStart: 0,
      rangeEnd: 0,
      remaining: 0,
    });
    const restored = await post({ ...body(middle.id, exhausted.contentRevision), kind: 'revert' });
    expect(restored.values).toMatchObject({ reviewState: 'llm_reviewed', pending: false });
    const cleared = await post({ ...body(first.id, restored.contentRevision), kind: 'revert' });
    expect(await get('review?search=find%20this')).toMatchObject({ total: 0 });
    expect(await get('review?source=rule')).toMatchObject({
      total: 1,
      remaining: 1,
      rows: [{ id: first.id }],
    });
    const evicted = await post({
      ...body(first.id, cleared.contentRevision),
      kind: 'mark-next',
      query: { reviewState: 'unreviewed' },
    });
    expect(evicted.navigation).toMatchObject({ remaining: 0, nextEligibleId: null });
    expect(await get('review')).toMatchObject({ remaining: 1 });
    expect(await readFile(fixture.input, 'utf8')).toBe(fixture.sourceBytes);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});
