import { expect, it } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import { start } from './license-reassessment-http.test-fixtures';

it.each(['success', 'failure', 'stop'] as const)(
  'stages and deduplicates a paid batch through %s',
  async (outcome) => {
    const f = await makeCommandFixture(false);
    const ids = f.artifact.classifications
      .slice(0, 2)
      .map((row) => licenseKeyDigest(row.normalizedText));
    const app = await start(f, ...ids.map((id) => `--rerun-model=${id}`));
    const wait = Promise.withResolvers<void>();
    let calls = 0;
    f.dependencies.transport.mockImplementation(async () => {
      const current = ++calls;
      await wait.promise;
      if (outcome === 'failure' && current > f.options.sampleCount) throw new Error('fake failure');
      return '{"rationale":"Fake paid evidence.","decision":"allowed"}';
    });
    try {
      const view = await app.operate('inspect');
      const prior = await Promise.all(ids.map(async (id) => (await app.api(`review/${id}`)).body));
      const body = {
        operationId: crypto.randomUUID(),
        configurationRevision: 1,
        paid: {
          maximumRequests: view.paidEstimate.expectedUncachedRequests,
          fingerprint: view.paidEstimate.fingerprint,
          replacementConfirmations: [],
        },
      };
      expect(calls).toBe(0);
      expect(body.paid.maximumRequests).toBe(2 * f.options.sampleCount);
      const responses = await Promise.all([app.api('paid', body), app.api('paid', body)]);
      expect(responses.map((r) => r.status)).toEqual([202, 202]);
      await expect.poll(() => calls).toBe(f.options.sampleCount);
      expect((await app.api('paid', { ...body, operationId: crypto.randomUUID() })).status).toBe(
        409
      );
      if (outcome === 'stop') expect((await app.api('stop', null)).status).toBe(200);
      wait.resolve();
      const receipt = async () => (await app.api(`operations/${body.operationId}`)).body;
      await expect
        .poll(async () => (await receipt()).state)
        .toBe(outcome === 'success' ? 'succeeded' : 'failed');
      expect((await receipt()).progress.attempts).toBe(calls);
      expect(calls).toBe(outcome === 'stop' ? f.options.sampleCount : body.paid.maximumRequests);
      expect((await app.api('paid', body)).body).toEqual(await receipt());
      const after = (await app.api('setup')).body;
      expect(after.contentRevision).toBe(view.contentRevision + Number(outcome === 'success'));
      for (const [index, id] of ids.entries()) {
        const row = (await app.api(`review/${id}`)).body;
        if (outcome === 'success') expect(row.source).toBe('gemini');
        else expect(row).toEqual(prior[index]);
      }
    } finally {
      wait.resolve();
      await app.close();
      await f.cleanup();
    }
  }
);

it('requires independent current human and spending authorization, then removes the selected pending mark', async () => {
  const f = await makeCommandFixture(false);
  const app = await start(f);
  try {
    await app.operate('inspect');
    const list = (await app.api('review')).body;
    const id = list.rows[0].id;
    const mark = await app.api('review/draft', {
      kind: 'patch',
      mutationId: crypto.randomUUID(),
      epoch: list.epoch,
      id,
      contentRevision: list.contentRevision,
      reviewComment: 'Pending exception',
      touched: true,
    });
    expect(mark.status).toBe(200);
    const select = async () =>
      (
        await app.api('review/rerun', {
          kind: 'model',
          configurationRevision: 1,
          contentRevision: mark.body.contentRevision,
          id,
          operationId: crypto.randomUUID(),
        })
      ).body.paidEstimate;
    const submit = async (confirmed: boolean) => {
      const estimate = await select();
      const operationId = crypto.randomUUID();
      expect(
        (
          await app.api('paid', {
            operationId,
            configurationRevision: 1,
            paid: {
              maximumRequests: estimate.expectedUncachedRequests,
              fingerprint: estimate.fingerprint,
              replacementConfirmations: confirmed
                ? [estimate.outstanding[0].replacementConfirmation]
                : [],
            },
          })
        ).status
      ).toBe(202);
      await expect
        .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
        .toBe(confirmed ? 'succeeded' : 'failed');
    };
    await submit(false);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    expect((await app.api(`review/${id}`)).body.reviewComment).toBe('Pending exception');
    await submit(true);
    expect(f.dependencies.transport).toHaveBeenCalledTimes(f.options.sampleCount);
    const row = (await app.api(`review/${id}`)).body;
    expect(row).toMatchObject({ reviewState: 'llm_reviewed', source: 'gemini' });
    expect((await app.api('setup')).body.analysis.pendingReviews).toBe(0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

it.each(['cache growth', 'cache hit', 'draft', 'spend ceiling', 'credential'] as const)(
  'rejects paid execution for %s without a model request',
  async (change) => {
    const f = await makeCommandFixture(false);
    const row = f.artifact.classifications[0];
    const id = licenseKeyDigest(row.normalizedText);
    const cache = createRequestCache(f.options.cacheDir);
    const sample = buildLicenseSampleRequest(
      row.exampleNotice!,
      'google',
      f.options.model.slice(7),
      1
    );
    if (change === 'cache growth')
      await cache.write(sample, '{"rationale":"Valid fixture.","decision":"allowed"}');
    if (change === 'credential') f.dependencies.apiKey = '';
    const app = await start(f, `--rerun-model=${id}`);
    try {
      const view = await app.operate('inspect');
      const estimate = view.paidEstimate;
      if (change === 'cache growth') await cache.write(sample, 'invalid');
      if (change === 'cache hit')
        await cache.write(sample, '{"rationale":"Valid fixture.","decision":"allowed"}');
      if (change === 'draft') {
        const list = (await app.api('review')).body;
        expect(
          (
            await app.api('review/draft', {
              kind: 'mark',
              mutationId: crypto.randomUUID(),
              epoch: list.epoch,
              id,
              contentRevision: list.contentRevision,
            })
          ).status
        ).toBe(200);
      }
      const operationId = crypto.randomUUID();
      const submission = await app.api('paid', {
        operationId,
        configurationRevision: 1,
        paid: {
          fingerprint: estimate.fingerprint,
          maximumRequests: estimate.expectedUncachedRequests + Number(change === 'spend ceiling'),
          replacementConfirmations: [],
        },
      });
      expect(submission.status).toBe(202);
      await expect
        .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
        .toBe('failed');
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      expect((await app.api('setup')).body.contentRevision).toBe(
        view.contentRevision + Number(change === 'draft')
      );
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

it('uses the approved partial cache and counts a retry as another attempt', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications[0];
  const id = licenseKeyDigest(row.normalizedText);
  const cache = createRequestCache(f.options.cacheDir);
  const vote = '{"rationale":"Approved fixture.","decision":"allowed"}';
  for (let i = 1; i < f.options.sampleCount; i++)
    await cache.write(
      buildLicenseSampleRequest(row.exampleNotice!, 'google', f.options.model.slice(7), i),
      vote
    );
  f.dependencies.transport
    .mockResolvedValueOnce('invalid structured output')
    .mockResolvedValue(vote);
  const app = await start(f, `--rerun-model=${id}`);
  try {
    const view = await app.operate('inspect');
    const estimate = view.paidEstimate;
    expect(estimate.expectedUncachedRequests).toBe(1);
    const operationId = crypto.randomUUID();
    expect(
      (
        await app.api('paid', {
          operationId,
          configurationRevision: 1,
          paid: {
            fingerprint: estimate.fingerprint,
            maximumRequests: 1,
            replacementConfirmations: [],
          },
        })
      ).status
    ).toBe(202);
    const receipt = async () => (await app.api(`operations/${operationId}`)).body;
    await expect.poll(async () => (await receipt()).state, { timeout: 5000 }).toBe('succeeded');
    expect((await receipt()).progress.attempts).toBe(2);
    expect(f.dependencies.transport).toHaveBeenCalledTimes(2);
    expect(
      (await app.api(`review/${id}`)).body.samples.map(
        (sample: { cacheHit: boolean }) => sample.cacheHit
      )
    ).toEqual([true, true, false]);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
