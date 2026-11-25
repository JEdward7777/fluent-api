import { writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { recordHumanLicenseDecision, serializeLicenseArtifact } from '../license-artifact';
import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import { LicenseWorkbenchSession } from './license-workbench-session';
import { LicenseWorkflow } from './license-workflow';

async function cacheSample(
  f: Awaited<ReturnType<typeof makeCommandFixture>>,
  notice: string,
  index: number,
  valid = true
) {
  const request = buildLicenseSampleRequest(
    notice,
    'google',
    f.options.model.replace(/^google:/, ''),
    index
  );
  await createRequestCache(f.options.cacheDir).write(
    request,
    valid ? '{"rationale":"Permitted by fixture.","decision":"allowed"}' : 'invalid fixture'
  );
}

it('publishes complete rule and cache results together and estimates only missing or malformed samples on the new revision', async () => {
  const f = await makeCommandFixture(false);
  const workflow = new LicenseWorkflow(
    { ...f.options, source: 'database' },
    { ...f.dependencies, destinationDatabase: f.dependencies.database }
  );
  try {
    const [rule, hit, miss] = f.artifact.classifications;
    for (let index = 1; index <= f.options.sampleCount; index++)
      await cacheSample(f, hit.exampleNotice!, index);
    await cacheSample(f, miss.exampleNotice!, 1);
    await cacheSample(f, miss.exampleNotice!, 2, false);
    await workflow.inspect(1);
    const artifact = workflow.analyzed!.artifact;
    const read = (key: string) =>
      artifact.classifications.find((row) => row.normalizedText === key);
    expect(workflow.paidEstimate).toMatchObject({
      contentRevision: 2,
      expectedUncachedRequests: f.options.sampleCount - 1,
      outstanding: [{ id: licenseKeyDigest(miss.normalizedText), missing: [2, 3] }],
      cost: { status: 'unavailable' },
    });
    expect(read(rule.normalizedText)).toMatchObject({ source: 'rule', status: 'forbidden' });
    expect(read(hit.normalizedText)).toMatchObject({ source: 'gemini', status: 'allowed' });
    expect(
      read(hit.normalizedText)?.samples.every((sample) => sample.cacheHit && !sample.attempts)
    ).toBe(true);
    expect(read(miss.normalizedText)).toMatchObject({
      source: 'table',
      status: 'unknown',
      samples: [],
    });
    const prior = workflow.paidEstimate;
    await workflow.prepareFree(2);
    expect(workflow.paidEstimate).toEqual(prior);
    for (let index = 2; index <= f.options.sampleCount; index++)
      await cacheSample(f, miss.exampleNotice!, index);
    await workflow.prepareFree(2);
    expect(workflow.paidEstimate).toMatchObject({
      contentRevision: 3,
      expectedUncachedRequests: 0,
    });
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it.each([
  { human: 'historic', kind: 'rule' },
  { human: 'pending', kind: 'rule' },
  { human: 'historic', kind: 'model' },
  { human: 'pending', kind: 'model' },
] as const)(
  'protects $human decisions from $kind replacement until confirmed at the current revision',
  async ({ human, kind }) => {
    const f = await makeCommandFixture(false);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      const [row, other] = f.artifact.classifications;
      const id = licenseKeyDigest(row.normalizedText);
      if (human === 'historic')
        await writeFile(
          f.input,
          serializeLicenseArtifact(
            recordHumanLicenseDecision(
              f.artifact,
              row.normalizedText,
              'unknown',
              { reviewComment: 'Historic decision' },
              'Prior reviewer',
              '2026-02-01T00:00:00.000Z'
            )
          ).bytes
        );
      if (kind === 'model')
        for (let index = 1; index <= f.options.sampleCount; index++)
          await cacheSample(f, row.exampleNotice!, index);
      await workflow.inspect(1);
      const mark = (key: string, comment: string) =>
        workflow.mutateDraft(
          {
            id: licenseKeyDigest(key),
            epoch: workflow.reviewDrafts.epoch,
            contentRevision: workflow.status.contentRevision,
            mutationId: crypto.randomUUID(),
            kind: 'patch',
            status: 'unknown',
            reviewComment: comment,
            touched: true,
          },
          true
        );
      if (human === 'pending') mark(row.normalizedText, 'Unpublished comment');
      const original = workflow.analyzed!.artifact;
      const originalRow = original.classifications[0];
      const effective = workflow.reviewDrafts.values(originalRow);
      const selection = { id, kind };
      const stage = () => workflow.prepareFree(workflow.status.contentRevision, selection);
      const first = (await stage()).replacements[0];
      expect(workflow.analyzed!.artifact).toBe(original);
      expect(workflow.reviewDrafts.values(originalRow)).toEqual(effective);
      workflow.cancelFreeSelection(workflow.status.contentRevision, first);
      await expect(workflow.prepareFree(workflow.status.contentRevision, first)).rejects.toThrow(
        'Stale'
      );
      const second = (await stage()).replacements[0];
      const unrelated = mark(other.normalizedText, 'Independent pending comment');
      expect(workflow.paidEstimate).toBeUndefined();
      await expect(workflow.prepareFree(workflow.status.contentRevision, second)).rejects.toThrow(
        'Stale'
      );
      expect(workflow.analyzed!.artifact).toBe(original);
      expect(workflow.reviewDrafts.values(originalRow)).toEqual(effective);
      if (human === 'pending') {
        const stale = (await stage()).replacements[0];
        const changed = mark(row.normalizedText, 'Edited after the confirmation was displayed');
        await expect(workflow.prepareFree(workflow.status.contentRevision, stale)).rejects.toThrow(
          'Stale'
        );
        expect(workflow.reviewDrafts.values(originalRow)).toEqual(changed.values);
      }
      if (kind === 'model') {
        const stale = (await stage()).replacements[0];
        const beforeCacheChange = workflow.reviewDrafts.values(originalRow);
        await cacheSample(f, row.exampleNotice!, 1, false);
        await expect(workflow.prepareFree(workflow.status.contentRevision, stale)).rejects.toThrow(
          'Stale'
        );
        expect(workflow.analyzed!.artifact).toBe(original);
        expect(workflow.reviewDrafts.values(originalRow)).toEqual(beforeCacheChange);
        await cacheSample(f, row.exampleNotice!, 1);
      }
      const third = (await stage()).replacements[0];
      const next = await workflow.prepareFree(workflow.status.contentRevision, third);
      expect(next.expectedUncachedRequests).toBe(0);
      const replaced = workflow.analyzed!.artifact.classifications[0];
      expect(replaced).toMatchObject({ source: kind === 'rule' ? 'rule' : 'gemini' });
      expect(workflow.reviewDrafts.values(replaced).pending).toBe(false);
      if (human === 'historic')
        expect(replaced.reviewHistory).toContainEqual(
          expect.objectContaining({
            reviewedBy: 'Prior reviewer',
            reviewComment: 'Historic decision',
          })
        );
      expect(workflow.reviewDrafts.values(other)).toEqual(unrelated.values);
      expect(workflow.analyzed!.originalSourceArtifact).toEqual(original);
      expect(f.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

it('reuses loaded data for free preparation and settles failed pool cleanup on both replacement paths', async () => {
  const fixture = await makeCommandFixture(false);
  const session = new LicenseWorkbenchSession(
    { ...fixture.options, source: 'database' },
    false,
    fixture.dependencies
  );
  const secret = 'test cleanup details';
  const operate = async (kind: 'inspect' | 'analysis') => {
    const { operationId } = session.start(kind, {
      configurationRevision: session.visible.configurationRevision,
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(session.operation(operationId)?.state).not.toBe('running'));
    return session.operation(operationId);
  };
  const selectDatabase = async (database: string) =>
    session.configure({
      ...fixture.options,
      source: 'database',
      destination: 'json',
      reportFormats: 'none',
      cacheDir: fixture.options.cacheDir ?? null,
      reportDir: null,
      configurationRevision: session.visible.configurationRevision,
      expectedContentRevision: session.visible.contentRevision,
      discardReviewedState: true,
      sourceDatabaseConnection: {
        mode: 'session',
        host: '127.0.0.1',
        port: 1,
        database,
        username: 'reader',
        password: secret,
        clearPassword: false,
        tls: 'disable',
      },
    });
  try {
    expect((await operate('inspect'))?.state).toBe('succeeded');
    expect((await operate('analysis'))?.state).toBe('succeeded');
    expect(fixture.adapter.load).toHaveBeenCalledOnce();
    expect(fixture.dependencies.transport).not.toHaveBeenCalled();
    await selectDatabase('first');
    fixture.adapter.close.mockRejectedValueOnce(new Error(secret));
    expect(await operate('inspect')).toMatchObject({
      state: 'succeeded',
      cleanupWarning: expect.stringContaining('cleanup'),
    });
    expect(session.visible.activeOperationId).toBeNull();
    const prior = session.visible;
    await selectDatabase('replacement');
    fixture.adapter.load.mockRejectedValueOnce(new Error('could not load'));
    fixture.adapter.close.mockRejectedValueOnce(new Error(secret));
    expect(await operate('inspect')).toMatchObject({
      state: 'failed',
      cleanupWarning: expect.stringContaining('cleanup'),
    });
    expect(session.visible).toMatchObject({
      activeOperationId: null,
      loadRevision: prior.loadRevision,
      analysis: prior.analysis,
      inspected: prior.inspected,
    });
    expect(JSON.stringify(session.visible)).not.toContain(secret);
    expect((await operate('inspect'))?.state).toBe('succeeded');
  } finally {
    await session.close();
    await fixture.cleanup();
  }
});
