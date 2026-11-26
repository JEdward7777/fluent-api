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

it('keeps an explicitly selected fresh estimate scoped through refresh and rejects superseded authorization', async () => {
  const f = await makeCommandFixture(false);
  const [selected, other] = f.artifact.classifications;
  const id = licenseKeyDigest(selected.normalizedText);
  const otherId = licenseKeyDigest(other.normalizedText);
  const app = await start(f, `--rerun-model=${id}`);
  try {
    const cache = createRequestCache(f.options.cacheDir);
    for (let index = 1; index <= f.options.sampleCount; index++)
      await cache.write(
        buildLicenseSampleRequest(
          selected.exampleNotice!,
          'google',
          f.options.model.slice(7),
          index
        ),
        '{"rationale":"Cached fixture.","decision":"allowed"}'
      );
    const loaded = await app.operate('inspect');
    expect(loaded.paidEstimate.expectedUncachedRequests).toBe(0);
    let revision = loaded.contentRevision;
    const list = (await app.api('review')).body;
    for (const key of [id, otherId]) {
      const edit = await app.api('review/draft', {
        kind: 'patch',
        id: key,
        mutationId: crypto.randomUUID(),
        epoch: list.epoch,
        contentRevision: revision,
        status: 'forbidden',
        reviewComment: `Exact comment for ${key}`,
        touched: true,
      });
      expect(edit.status).toBe(200);
      revision = edit.body.contentRevision;
    }
    const select = async (key: string) =>
      (
        await app.api('review/rerun', {
          configurationRevision: loaded.configurationRevision,
          contentRevision: revision,
          operationId: crypto.randomUUID(),
          kind: 'model',
          id: key,
        })
      ).body;
    const first = await select(id);
    const refresh = {
      configurationRevision: first.configurationRevision,
      contentRevision: revision,
      loadRevision: first.loadRevision,
      estimateRevision: first.estimateRevision,
      model: first.model,
      sampleCount: first.sampleCount + 1,
      noCache: false,
      cacheDir: first.cacheDir,
    };
    expect(first.paidEstimate).toMatchObject({
      expectedUncachedRequests: first.sampleCount,
      cacheReadEnabled: false,
      selection: { id, kind: 'model' },
      outstanding: [{ id, human: true }],
    });
    const request = {
      configurationRevision: first.configurationRevision,
      contentRevision: revision,
      estimateRevision: first.estimateRevision,
      kind: 'model',
      id: otherId,
      operationId: crypto.randomUUID(),
    };
    const accepted = await app.api('review/rerun', request);
    expect(accepted.status).toBe(200);
    const otherQuote = accepted.body;
    expect(await app.api('review/rerun', request)).toEqual(accepted);
    expect(
      (await app.api('review/rerun', { ...request, estimateRevision: otherQuote.estimateRevision }))
        .status
    ).toBe(409);
    expect(
      (await app.api('review/rerun', { ...request, operationId: crypto.randomUUID(), id })).status
    ).toBe(409);
    expect((await app.api('ai/estimate', refresh)).status).toBe(409);
    expect(
      (
        await app.api('ai/estimate', {
          ...refresh,
          estimateRevision: otherQuote.estimateRevision,
          reassessmentScopeRevision: first.reassessmentScopeRevision,
        })
      ).status
    ).toBe(409);
    expect((await app.api('setup')).body.paidEstimate).toEqual(otherQuote.paidEstimate);
    const again = await select(id);
    const latest = (
      await app.api('ai/estimate', { ...refresh, estimateRevision: again.estimateRevision })
    ).body;
    const repeated = await app.api('analysis', {
      operationId: crypto.randomUUID(),
      configurationRevision: latest.configurationRevision,
    });
    await expect
      .poll(async () => (await app.api(`operations/${repeated.body.operationId}`)).body.state)
      .toBe('succeeded');
    const estimate = (await app.api('setup')).body.paidEstimate;
    expect(estimate).toMatchObject({
      expectedUncachedRequests: refresh.sampleCount,
      selection: { id, kind: 'model' },
      outstanding: [{ id, human: true }],
    });
    const pay = async (fingerprint: string, confirmation: string) => {
      const operationId = crypto.randomUUID();
      expect(
        (
          await app.api('paid', {
            operationId,
            configurationRevision: latest.configurationRevision,
            paid: {
              fingerprint,
              maximumRequests: refresh.sampleCount,
              replacementConfirmations: [confirmation],
            },
          })
        ).status
      ).toBe(202);
      return () => app.api(`operations/${operationId}`).then((response) => response.body.state);
    };
    await expect
      .poll(
        await pay(
          first.paidEstimate.fingerprint,
          first.paidEstimate.outstanding[0].replacementConfirmation
        )
      )
      .toBe('failed');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    for (const key of [id, otherId])
      expect((await app.api(`review/${key}`)).body).toMatchObject({
        status: 'forbidden',
        pending: true,
        reviewComment: `Exact comment for ${key}`,
      });
    await expect
      .poll(await pay(estimate.fingerprint, estimate.outstanding[0].replacementConfirmation))
      .toBe('succeeded');
    expect(f.dependencies.transport).toHaveBeenCalledTimes(refresh.sampleCount);
    const after = (await app.api('setup')).body;
    expect(after.selectedPaid).toMatchObject({
      selectedModel: {
        id,
        decision: 'allowed',
        freshSamples: refresh.sampleCount,
        reusedSamples: 0,
      },
    });
    const finished = await app.api('ai/estimate', {
      ...refresh,
      configurationRevision: after.configurationRevision,
      contentRevision: after.contentRevision,
      estimateRevision: after.estimateRevision,
    });
    expect(finished.body.paidEstimate).toMatchObject({
      selection: { id, kind: 'model' },
      expectedUncachedRequests: 0,
    });
    expect(f.dependencies.transport).toHaveBeenCalledTimes(refresh.sampleCount);
    expect((await app.api(`review/${otherId}`)).body).toMatchObject({
      status: 'forbidden',
      pending: true,
      reviewComment: `Exact comment for ${otherId}`,
    });
  } finally {
    await app.close();
    await f.cleanup();
  }
});
