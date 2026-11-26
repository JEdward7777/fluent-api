import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import * as preparation from './license-free-preparation';
import * as database from './license-workbench-database';
import { LicenseWorkbenchSession } from './license-workbench-session';
import { licenseFileIo } from './license-write';

it('prepares once per successful Load and commits only a ready source with current discard consent', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications.find((item) => item.source === 'gemini')!;
  const id = licenseKeyDigest(row.normalizedText);
  const cache = createRequestCache(f.options.cacheDir);
  const prepare = vi.spyOn(preparation, 'stageFreePreparation');
  const test = vi.spyOn(database, 'testWorkbenchDatabase').mockResolvedValue();
  const read = vi.fn(licenseFileIo.read);
  const session = new LicenseWorkbenchSession(
    { ...f.options, source: undefined, rerunModel: [id] },
    false,
    { ...f.dependencies, fs: { ...licenseFileIo, read } }
  );
  const request = () => ({
    operationId: crypto.randomUUID(),
    configurationRevision: session.visible.configurationRevision,
  });
  const done = async (operation: { operationId: string }, state = 'succeeded') =>
    vi.waitFor(() => expect(session.operation(operation.operationId)?.state).toBe(state));
  try {
    for (let index = 1; index <= f.options.sampleCount; index++)
      await cache.write(
        buildLicenseSampleRequest(
          row.exampleNotice!,
          'google',
          f.options.model.slice('google:'.length),
          index
        ),
        '{"rationale":"Fixture permission.","decision":"allowed"}'
      );
    const json = { ...request(), sourceSettings: { source: 'json' as const, input: f.input } };
    await done(session.start('inspect', json));
    expect(session.start('inspect', json).state).toBe('succeeded');
    expect(session.visible).toMatchObject({
      analysis: { rows: f.artifact.classifications.length },
      paidEstimate: { expectedUncachedRequests: 0 },
      source: 'json',
      loadedSource: { input: f.input },
      loadRevision: 1,
    });
    expect(read.mock.calls).toEqual([[f.input]]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    const detail = session.reviewDetail(id);
    const mark = session.mutateDraft({
      id,
      epoch: detail.epoch!,
      contentRevision: detail.contentRevision,
      mutationId: crypto.randomUUID(),
      kind: 'patch',
      touched: true,
      status: 'forbidden',
      reviewComment: 'Keep this exact comment.',
    });
    expect(mark.conflict).toBe(false);
    const previous = session.visible;
    const connection = {
      mode: 'session' as const,
      host: 'localhost',
      port: 5432,
      database: 'fixture',
      username: 'draft-user',
      password: 'draft-secret',
      clearPassword: false,
      tls: 'disable' as const,
    };
    await session.testDatabase(previous.sourceRevision, connection, 'source');
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ password: connection.password }),
      'draft-test'
    );
    expect(session.visible).toEqual(previous);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    // A legacy two-step client's discard grant cannot authorize this tab's new Load.
    await session.configure({
      ...f.options,
      source: 'json',
      destination: 'json',
      reportFormats: 'none',
      cacheDir: previous.cacheDir,
      reportDir: previous.reportDir,
      discardReviewedState: true,
      expectedContentRevision: previous.contentRevision,
      configurationRevision: previous.configurationRevision,
    });
    const retained = session.visible;
    const replacement = {
      ...request(),
      sourceSettings: { source: 'database' as const, connection },
    };
    expect(() => session.start('inspect', replacement)).toThrow('discard acknowledgement');
    const consent = {
      discardReviewedState: true,
      expectedContentRevision: previous.contentRevision,
    };
    const failed = session.start('inspect', {
      ...request(),
      ...consent,
      sourceSettings: { source: 'json', input: join(f.dir, 'missing.json') },
    });
    await done(failed, 'failed');
    expect(session.visible).toMatchObject({
      loadedSource: previous.loadedSource,
      sourceDraftPending: false,
      source: 'json',
      input: f.input,
      loadRevision: previous.loadRevision,
      configurationRevision: retained.configurationRevision,
      analysis: { pendingReviews: 1 },
    });
    expect(session.reviewDetail(id)).toMatchObject({
      status: 'forbidden',
      reviewComment: 'Keep this exact comment.',
    });
    expect(f.adapter.load).not.toHaveBeenCalled();
    await done(session.start('inspect', { ...replacement, ...consent }));
    expect(session.visible.paidEstimate!.expectedUncachedRequests).toBeGreaterThan(0);
    expect(session.visible).toMatchObject({
      source: 'database',
      loadedSource: { source: 'database' },
      loadRevision: 2,
      sourceDatabaseConnection: { database: 'fixture', passwordRetained: true },
      output: f.output,
    });
    expect(JSON.stringify(session.visible)).not.toContain(connection.password);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.adapter.load).toHaveBeenCalledTimes(1);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    test.mockRestore();
    prepare.mockRestore();
    await session.close();
    await f.cleanup();
  }
});

it.each([false, true])(
  'loads reviewable practice rows without publishing scratch output (already inspected %s)',
  async (legacy) => {
    const f = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession({ ...f.options, input: '' }, true, f.dependencies);
    try {
      if (legacy) {
        const inspect = session.start('inspect', {
          configurationRevision: 1,
          operationId: crypto.randomUUID(),
        });
        await vi.waitFor(() =>
          expect(session.operation(inspect.operationId)?.state).toBe('succeeded')
        );
        expect(session.visible.analysis).toBeNull();
      }
      const initialScratch = session.visible.scratch;
      const op = session.start('inspect', {
        configurationRevision: 1,
        operationId: crypto.randomUUID(),
        sourceSettings: { source: 'json', input: 'Bundled example' },
      });
      await vi.waitFor(() => expect(session.operation(op.operationId)?.state).toBe('succeeded'));
      expect(session.visible.analysis!.rows).toBeGreaterThan(0);
      expect(session.visible).toMatchObject({
        practice: true,
        loadRevision: 1,
        paidEstimate: null,
        preview: null,
      });
      if (legacy) expect(session.visible.scratch).toBe(initialScratch);
      expect(await licenseFileIo.read(session.visible.output)).toBeNull();
      expect(f.dependencies.database).not.toHaveBeenCalled();
      expect(f.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      const scratch = session.visible.scratch;
      await session.close();
      if (scratch) await rm(scratch, { recursive: true, force: true });
      await f.cleanup();
    }
  }
);

it('reselects the retained review from a legacy pending source without reading or preparing it again', async () => {
  const f = await makeCommandFixture(false);
  const read = vi.fn(licenseFileIo.read);
  const session = new LicenseWorkbenchSession(f.options, false, {
    ...f.dependencies,
    fs: { ...licenseFileIo, read },
  });
  const prepare = vi.spyOn(preparation, 'stageFreePreparation');
  try {
    const first = session.start('inspect', {
      operationId: crypto.randomUUID(),
      configurationRevision: 1,
    });
    await vi.waitFor(() => expect(session.operation(first.operationId)?.state).toBe('succeeded'));
    const row = f.artifact.classifications[0];
    const id = licenseKeyDigest(row.normalizedText);
    const detail = session.reviewDetail(id);
    session.mutateDraft({
      kind: 'patch',
      id,
      mutationId: crypto.randomUUID(),
      epoch: detail.epoch!,
      contentRevision: detail.contentRevision,
      touched: true,
      status: 'forbidden',
      reviewComment: 'Preserve me.',
    });
    const before = await session.selectRerun({
      id,
      kind: 'model',
      contentRevision: session.visible.contentRevision,
      configurationRevision: session.visible.configurationRevision,
    });
    const count = prepare.mock.calls.length;
    const pending = await session.configure({
      ...f.options,
      source: 'json',
      destination: 'json',
      input: join(f.dir, 'b.json'),
      configurationRevision: before.configurationRevision,
      cacheDir: before.cacheDir,
      reportDir: before.reportDir,
      reportFormats: 'none',
      discardReviewedState: false,
    });
    expect(pending.paidEstimate).toBeNull();
    const restore = session.start('inspect', {
      operationId: crypto.randomUUID(),
      configurationRevision: pending.configurationRevision,
      sourceSettings: { source: 'json', input: f.input },
    });
    await vi.waitFor(() => expect(session.operation(restore.operationId)?.state).toBe('succeeded'));
    expect(session.visible).toMatchObject({
      sourceDraftPending: false,
      input: f.input,
      loadRevision: before.loadRevision,
      contentRevision: before.contentRevision,
      analysis: before.analysis,
      paidEstimate: before.paidEstimate,
    });
    expect(session.reviewDetail(id)).toMatchObject({
      epoch: detail.epoch,
      status: 'forbidden',
      reviewComment: 'Preserve me.',
      pending: true,
    });
    expect(read.mock.calls).toEqual([[f.input]]);
    expect(prepare).toHaveBeenCalledTimes(count);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    await session.close();
    await f.cleanup();
  }
});

it('acknowledges equivalent re-entered database credentials without replacing the current review', async () => {
  const f = await makeCommandFixture(false);
  const session = new LicenseWorkbenchSession(f.options, false, f.dependencies);
  const prepare = vi.spyOn(preparation, 'stageFreePreparation');
  const connection = {
    mode: 'session' as const,
    host: 'localhost',
    port: 5432,
    database: 'test',
    username: 'reader',
    password: 'fixture-password',
    clearPassword: false,
    tls: 'disable' as const,
  };
  const load = async () => {
    const op = session.start('inspect', {
      operationId: crypto.randomUUID(),
      configurationRevision: session.visible.configurationRevision,
      sourceSettings: { source: 'database', connection },
    });
    await vi.waitFor(() => expect(session.operation(op.operationId)?.state).toBe('succeeded'));
    return op.operationId;
  };
  try {
    await load();
    const id = licenseKeyDigest(f.artifact.classifications[0].normalizedText);
    const detail = session.reviewDetail(id);
    session.mutateDraft({
      id,
      epoch: detail.epoch!,
      contentRevision: detail.contentRevision,
      kind: 'patch',
      mutationId: crypto.randomUUID(),
      touched: true,
      status: 'forbidden',
      reviewComment: 'Retain this draft.',
    });
    const before = await session.selectRerun({
      id,
      kind: 'model',
      configurationRevision: session.visible.configurationRevision,
      contentRevision: session.visible.contentRevision,
    });
    const operationId = await load();
    expect(session.visible).toMatchObject({
      loadRevision: before.loadRevision,
      sourceRevision: before.sourceRevision,
      configurationRevision: before.configurationRevision,
      contentRevision: before.contentRevision,
      paidEstimate: before.paidEstimate,
      analysis: { pendingReviews: 1 },
      lastSourceLoad: { operationId, sourceRevision: before.sourceRevision },
    });
    expect(session.reviewDetail(id)).toMatchObject({
      epoch: detail.epoch,
      pending: true,
      reviewComment: 'Retain this draft.',
      status: 'forbidden',
    });
    expect(() =>
      session.start('inspect', {
        operationId: crypto.randomUUID(),
        configurationRevision: before.configurationRevision,
      })
    ).toThrow('already loaded');
    expect(f.adapter.load).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    await session.close();
    await f.cleanup();
  }
});
