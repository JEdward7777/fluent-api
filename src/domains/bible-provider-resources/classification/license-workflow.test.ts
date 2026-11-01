import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkflow } from './license-workflow';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture(attested = true) {
  const value = await makeCommandFixture(attested);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

describe('license workflow inspection and analysis', () => {
  it('starts without reads, then keeps JSON-to-JSON inspection and analysis offline', async () => {
    const f = await fixture();
    const read = vi.fn(async (path: string) => (path === f.input ? f.sourceBytes : null));
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: { read, write: vi.fn(), rename: vi.fn(), remove: vi.fn(), mkdir: vi.fn() },
    });
    expect(workflow.status.state).toBe('configuring');
    expect(read).not.toHaveBeenCalled();
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const inspected = await workflow.inspect(1);
    expect(inspected.inputBytes).toBe(f.sourceBytes);
    expect(inspected.outputBytes).toBeNull();
    expect(inspected.preflight).toMatchObject({
      source: 'json',
      distinctKeys: 3,
      historicalClassificationKeys: 3,
      tableHits: 0,
      ruleHits: 0,
      modelKeys: 0,
      expectedUncachedRequests: 0,
      cost: { status: 'unavailable' },
    });
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const analyzed = await workflow.startAnalysis(1);
    expect(analyzed.artifact.reviewContentHash).toBe(f.artifact.reviewContentHash);
    expect(analyzed.contentRevision).toBe(1);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('does not infer while inspecting the database and closes its owned adapter', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    await workflow.inspect(1);
    expect(f.adapter.load).toHaveBeenCalledOnce();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.startAnalysis(1);
    expect(f.dependencies.transport).toHaveBeenCalledTimes(6);
    await workflow.close();
    await workflow.close();
    expect(f.adapter.close).toHaveBeenCalledOnce();
  });

  it('rejects source catalogue drift before inference and requires another inspection', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    const inspected = await workflow.inspect(1);
    const originalName = inspected.database!.context.resources[0].name;
    f.snapshot.context.resources[0].name = 'Changed after inspection';
    expect(() => {
      inspected.database!.context.resources[0].name = 'Caller mutation';
    }).toThrow();
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect inputs again');
    expect(workflow.status.state).toBe('configuring');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const refreshed = await workflow.inspect(1);
    expect(refreshed.database!.context.resources[0].name).not.toBe(originalName);
    await workflow.close();
  });

  it('counts exact, rule and model keys with per-sample valid cache hits and unavailable cost', async () => {
    const f = await fixture();
    f.snapshot.classifications.push({
      normalizedText: f.artifact.classifications[2].normalizedText,
      status: 'unknown',
      rationale: 'Stored decision',
      classifiedBy: null,
      reviewedAt: null,
    });
    const model = f.options.model.replace(/^google:/, '');
    const notice = f.artifact.catalog[1].rawNotice!;
    const cache = createRequestCache(f.options.cacheDir);
    await cache.write(
      buildLicenseSampleRequest(notice, 'google', model, 1),
      '{"rationale":"Cached permission.","decision":"allowed"}'
    );
    await cache.write(buildLicenseSampleRequest(notice, 'google', model, 2), '{}');
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    const { preflight } = await workflow.inspect(1);
    expect(preflight).toMatchObject({
      distinctKeys: 3,
      tableHits: 1,
      ruleHits: 1,
      modelKeys: 1,
      validCacheHits: 1,
      expectedUncachedRequests: 2,
      maximumAttempts: 10,
      cost: { status: 'unavailable' },
    });
    expect(
      preflight.samples.map(({ validCacheHit, maximumAttempts }) => [
        validCacheHit,
        maximumAttempts,
      ])
    ).toEqual([
      [true, 0],
      [false, 5],
      [false, 5],
    ]);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();

    const noCache = new LicenseWorkflow(
      { ...f.options, source: 'database', noCache: true },
      f.dependencies
    );
    expect((await noCache.inspect(1)).preflight).toMatchObject({
      cacheReadEnabled: false,
      validCacheHits: 0,
      expectedUncachedRequests: 3,
      maximumAttempts: 15,
    });
    await noCache.close();
  });

  it.each(['input', 'output'])('rejects %s byte drift before JSON analysis', async (changed) => {
    const f = await fixture();
    const files = new Map([[f.input, f.sourceBytes]]);
    const read = vi.fn(async (path: string) => files.get(path) ?? null);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: { read, write: vi.fn(), rename: vi.fn(), remove: vi.fn(), mkdir: vi.fn() },
    });
    expect(read).not.toHaveBeenCalled();
    await workflow.inspect(1);
    files.set(changed === 'input' ? f.input : f.output, 'externally changed');
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect inputs again');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('rejects policy and cache payload drift even when the valid-hit count stays constant', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    await workflow.inspect(1);
    f.snapshot.classifications.push({
      normalizedText: 'new authoritative key',
      status: 'unknown',
      rationale: 'Changed policy',
      classifiedBy: null,
      reviewedAt: null,
    });
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect inputs again');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();

    f.snapshot.classifications.pop();
    const cache = createRequestCache(f.options.cacheDir);
    const notice = f.artifact.catalog[1].rawNotice!;
    const request = buildLicenseSampleRequest(
      notice,
      'google',
      f.options.model.replace(/^google:/, ''),
      1
    );
    await cache.write(request, '{"rationale":"First.","decision":"allowed"}');
    const second = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    await second.inspect(1);
    await cache.write(request, '{"rationale":"Second.","decision":"forbidden"}');
    await expect(second.startAnalysis(1)).rejects.toThrow('Inspect inputs again');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await second.close();
  });

  it('rejects stale revisions, duplicate analysis and reconfiguration during analysis', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    await expect(workflow.inspect(0)).rejects.toThrow('Stale');
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect');
    await workflow.inspect(1);
    await expect(workflow.inspect(1)).rejects.toThrow('Cannot inspect');
    await workflow.startAnalysis(1);
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect');
    expect((await workflow.configure(f.options, 1, true)).configurationRevision).toBe(2);
    expect(workflow.analyzed).toBeUndefined();
    await expect(workflow.inspect(1)).rejects.toThrow('Stale');
    await workflow.close();
  });

  it('closes the database after inspection failure', async () => {
    const f = await fixture();
    f.snapshot.tableExists = false;
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    await expect(workflow.inspect(1)).rejects.toThrow('must exist');
    await workflow.close();
    expect(f.adapter.close).toHaveBeenCalledOnce();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });

  it('waits for active inspection before closing its adapter and does not revive closed state', async () => {
    const f = await fixture();
    let finishLoad: (() => void) | undefined;
    f.adapter.load.mockImplementationOnce(
      () =>
        new Promise<typeof f.snapshot>((resolve) => {
          finishLoad = () => resolve(structuredClone(f.snapshot));
        })
    );
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    const inspecting = workflow.inspect(1);
    expect(workflow.status.state).toBe('inspecting');
    await expect(workflow.configure(f.options, 1)).rejects.toThrow('Cannot configure');
    const closing = workflow.close();
    expect(f.adapter.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
    finishLoad!();
    await inspecting;
    await closing;
    expect(workflow.status.state).toBe('closed');
    expect(f.adapter.close).toHaveBeenCalledOnce();
    await expect(workflow.startAnalysis(1)).rejects.toThrow('closed');
  });

  it('rejects invalid classifier configuration before reading sources', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, sampleCount: 1 }, f.dependencies);
    await expect(workflow.inspect(1)).rejects.toThrow('at least two');
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('edits an exact row, invalidates preview, and requires the attested bytes to be previewed again', async () => {
    const f = await fixture(false);
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    await workflow.inspect(1);
    const initial = await workflow.startAnalysis(1);
    const original = await workflow.preview(1, 1);
    expect(original.reports.artifactBytes).toContain('"reviewState": "incomplete"');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const key = initial.artifact.classifications[0].normalizedText;
    const edited = workflow.editReview(
      {
        kind: 'disposition',
        normalizedText: key,
        status: 'allowed',
        reason: 'Checked source terms.',
      },
      1,
      1
    );
    expect(edited.warning).toContain('all-rights-reserved');
    expect(edited.analysis!.contentRevision).toBe(2);
    expect(workflow.previewed).toBeUndefined();
    expect(() =>
      workflow.attest(
        { reviewedBy: 'Reviewer', reviewReason: 'Checked', reviewedAt: '2026-11-01T00:00:00.000Z' },
        1,
        2,
        original.reports.reviewContentHash
      )
    ).toThrow('Preview');
    await expect(workflow.preview(1, 1)).rejects.toThrow('Stale');
    const changed = await workflow.preview(1, 2);
    expect(changed.reports.reviewContentHash).not.toBe(original.reports.reviewContentHash);
    const attested = workflow.attest(
      {
        reviewedBy: 'Reviewer',
        reviewReason: 'Checked exact candidate',
        reviewedAt: '2026-11-01T00:00:00.000Z',
      },
      1,
      2,
      changed.reports.reviewContentHash
    );
    expect(attested.contentRevision).toBe(3);
    expect(workflow.previewed).toBeUndefined();
    expect(attested.artifact.attestation?.reviewedBy).toBe('Reviewer');
    const signed = await workflow.preview(1, 3);
    expect(signed.reports.wholeFileHash).not.toBe(changed.reports.wholeFileHash);
    expect(signed.reports.reviewContentHash).toBe(changed.reports.reviewContentHash);
    await workflow.close();
  });

  it('rejects stale review commands, missing unknown notes, and catalogue drift before preview', async () => {
    const f = await fixture(false);
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    const unknown = workflow.analyzed!.artifact.classifications.find(
      (row) => row.status === 'unknown'
    )!;
    expect(() =>
      workflow.editReview(
        { kind: 'unknown-note', normalizedText: unknown.normalizedText, note: '' },
        1,
        1
      )
    ).toThrow('nonempty');
    const updated = workflow.editReview(
      {
        kind: 'unknown-note',
        normalizedText: unknown.normalizedText,
        note: 'Reviewed retained uncertainty.',
      },
      1,
      1
    );
    expect(updated.analysis!.contentRevision).toBe(2);
    expect(() =>
      workflow.editReview(
        { kind: 'unknown-note', normalizedText: unknown.normalizedText, note: 'Stale.' },
        1,
        1
      )
    ).toThrow('Stale');
    f.snapshot.context.resources[0].name = 'Externally changed catalogue';
    await expect(workflow.preview(1, 2)).rejects.toThrow('Inspect inputs again');
    expect(workflow.status.state).toBe('configuring');
    expect(workflow.analyzed).toBeUndefined();
    await workflow.close();
  });

  it('blocks edits and reconfiguration during preview and waits for the read before closing', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    let finishLoad: (() => void) | undefined;
    f.adapter.load.mockImplementationOnce(
      () =>
        new Promise<typeof f.snapshot>((resolve) => {
          finishLoad = () => resolve(structuredClone(f.snapshot));
        })
    );
    const pending = workflow.preview(1, 1);
    const retry = workflow.preview(1, 1);
    expect(workflow.status.state).toBe('previewing');
    expect(() =>
      workflow.editReview(
        {
          kind: 'unknown-note',
          normalizedText: f.artifact.classifications[2].normalizedText,
          note: 'Checked',
        },
        1,
        1
      )
    ).toThrow('Cannot edit');
    await expect(workflow.configure(f.options, 1)).rejects.toThrow('Cannot configure');
    const closing = workflow.close();
    expect(f.adapter.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
    finishLoad!();
    const [first, repeated] = await Promise.all([pending, retry]);
    expect(repeated).toBe(first);
    await closing;
    expect(workflow.status.state).toBe('closed');
    expect(f.adapter.close).toHaveBeenCalledOnce();
  });

  it('rechecks a completed preview before returning it again or accepting later attestation', async () => {
    const f = await fixture(false);
    const files = new Map([[f.input, f.sourceBytes]]);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: {
        read: async (path) => files.get(path) ?? null,
        write: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
        mkdir: vi.fn(),
      },
    });
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    const first = await workflow.preview(1, 1);
    files.set(f.input, 'externally changed after preview');
    await expect(workflow.preview(1, 1)).rejects.toThrow('Inspect inputs again');
    expect(workflow.previewed).toBeUndefined();
    expect(workflow.status.state).toBe('configuring');
    expect(() =>
      workflow.attest(
        { reviewedBy: 'Reviewer', reviewReason: 'Checked', reviewedAt: '2026-11-01T00:00:00.000Z' },
        1,
        1,
        first.reports.reviewContentHash
      )
    ).toThrow('Preview');
    await workflow.close();
  });
});
