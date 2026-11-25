import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { recordHumanLicenseDecision, serializeLicenseArtifact } from '../license-artifact';
import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import { start } from './license-reassessment-http.test-fixtures';

it.each([
  { flag: 'model', prior: 'rule', cached: true },
  { flag: 'model', prior: 'gemini', cached: true },
  { flag: 'model', prior: 'gemini', cached: false },
  { flag: 'rule', prior: 'rule', cached: false },
])(
  'honors --ui=web --rerun-$flag on saved $prior evidence (cache $cached)',
  async ({ flag, prior, cached }) => {
    const f = await makeCommandFixture(false);
    const row = f.artifact.classifications.find((item) => item.source === prior)!;
    const id = licenseKeyDigest(row.normalizedText);
    const app = await start(f, `--rerun-${flag}=${id}`);
    try {
      if (cached) {
        const cache = createRequestCache(f.options.cacheDir);
        for (let i = 1; i <= f.options.sampleCount; i++)
          await cache.write(
            buildLicenseSampleRequest(
              row.exampleNotice!,
              'google',
              f.options.model.replace(/^google:/, ''),
              i
            ),
            '{"rationale":"Cache fixture.","decision":"allowed"}'
          );
      }
      const view = await app.operate('inspect');
      const paid = flag === 'model' && !cached;
      expect(view.contentRevision).toBe(paid ? 1 : 2);
      expect(view.paidEstimate.expectedUncachedRequests).toBe(paid ? f.options.sampleCount : 0);
      const detail = (await app.api(`review/${id}`)).body;
      expect(detail.source).toBe(cached ? 'gemini' : prior);
      if (cached)
        expect(detail.samples).toEqual(
          expect.arrayContaining([expect.objectContaining({ cacheHit: true })])
        );
      if (flag === 'rule') expect(detail.decisionAt).toEqual(expect.any(String));
      const repeated = await app.operate('analysis');
      expect(repeated.contentRevision).toBe(view.contentRevision);
      expect(repeated.paidEstimate).toEqual(view.paidEstimate);
      expect(f.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

it('replays staged, canceled and confirmed operation receipts and rejects reused IDs with different arguments', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications[0];
  await writeFile(
    f.input,
    serializeLicenseArtifact(
      recordHumanLicenseDecision(
        f.artifact,
        row.normalizedText,
        'unknown',
        { reviewComment: 'Keep until confirmed.' },
        'Historical reviewer',
        '2026-01-01T00:00:00.000Z'
      )
    ).bytes
  );
  const id = licenseKeyDigest(row.normalizedText);
  const app = await start(f);
  try {
    const loaded = await app.operate('inspect');
    const stage = {
      configurationRevision: 1,
      contentRevision: loaded.contentRevision,
      kind: 'rule',
      id,
      operationId: crypto.randomUUID(),
    };
    const send = (request: object) => app.api('review/rerun', request);
    const { operationId: _stageId, ...legacyStage } = stage;
    const [legacy, legacyRetry] = await Promise.all([send(legacyStage), send(legacyStage)]);
    expect(legacy.status).toBe(200);
    expect(legacyRetry).toEqual(legacy);
    const stale = legacy.body.paidEstimate.replacements[0].confirmation;
    const [first, concurrent] = await Promise.all([send(stage), send(stage)]);
    expect(
      (await send({ ...stage, confirmation: stale, operationId: crypto.randomUUID() })).status
    ).toBe(409);
    expect(first.status).toBe(200);
    expect(concurrent).toEqual(first);
    const confirmation = first.body.paidEstimate.replacements[0].confirmation;
    expect((await send({ ...stage, kind: 'model' })).status).toBe(409);
    const cancel = { ...stage, confirmation, cancel: true, operationId: crypto.randomUUID() };
    const canceled = await send(cancel);
    expect(canceled.status).toBe(200);
    expect(await send(cancel)).toEqual(canceled);
    expect(await send(stage)).toEqual(first);
    expect((await send({ ...stage, confirmation, operationId: crypto.randomUUID() })).status).toBe(
      409
    );
    const restaged = await send({ ...stage, operationId: crypto.randomUUID() });
    const accept = {
      ...stage,
      confirmation: restaged.body.paidEstimate.replacements[0].confirmation,
      operationId: crypto.randomUUID(),
    };
    expect(accept.confirmation).not.toBe(confirmation);
    const [accepted, duplicate] = await Promise.all([send(accept), send(accept)]);
    expect(accepted.status).toBe(200);
    expect(duplicate).toEqual(accepted);
    expect(await send(accept)).toEqual(accepted);
    expect((await app.api('setup')).body.contentRevision).toBe(loaded.contentRevision + 1);
    expect((await send({ ...accept, cancel: true })).status).toBe(409);
    expect((await app.api(`review/${id}`)).body.source).toBe('rule');
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await f.cleanup();
  }
});

it.each([
  { kind: 'rule', cached: false },
  { kind: 'model', cached: true },
  { kind: 'model', cached: false },
])(
  'loads --rerun-$kind without replacing historic human evidence (model cache $cached)',
  async ({ kind, cached }) => {
    const f = await makeCommandFixture(false);
    const [row, other] = f.artifact.classifications;
    const id = licenseKeyDigest(row.normalizedText);
    await writeFile(
      f.input,
      serializeLicenseArtifact(
        recordHumanLicenseDecision(
          f.artifact,
          row.normalizedText,
          'unknown',
          { reviewComment: 'Historic exception.' },
          'Historic reviewer',
          '2026-01-01T00:00:00.000Z'
        )
      ).bytes
    );
    const cache = createRequestCache(f.options.cacheDir);
    for (const notice of cached ? [row, other] : [other])
      for (let i = 1; i <= f.options.sampleCount; i++)
        await cache.write(
          buildLicenseSampleRequest(
            notice.exampleNotice!,
            'google',
            f.options.model.replace(/^google:/, ''),
            i
          ),
          '{"rationale":"Controlled cached evidence.","decision":"allowed"}'
        );
    const app = await start(
      f,
      `--rerun-${kind}=${id}`,
      `--rerun-model=${licenseKeyDigest(other.normalizedText)}`
    );
    try {
      const loaded = await app.operate('inspect');
      expect(loaded.contentRevision).toBe(2);
      expect((await app.api(`review/${id}`)).body).toMatchObject({
        reviewedBy: 'Historic reviewer',
        status: 'unknown',
        reviewComment: 'Historic exception.',
      });
      if (kind === 'model' && !cached) {
        expect(loaded.paidEstimate).toMatchObject({
          expectedUncachedRequests: f.options.sampleCount,
          outstanding: [{ id, human: true }],
          replacements: [],
        });
      } else {
        expect(loaded.paidEstimate).toMatchObject({
          expectedUncachedRequests: 0,
          replacements: [{ id, kind }],
        });
        const confirmation = loaded.paidEstimate.replacements[0].confirmation;
        const promoted = await app.api('review/rerun', {
          id,
          kind,
          configurationRevision: loaded.configurationRevision,
          contentRevision: loaded.contentRevision,
          confirmation,
          operationId: crypto.randomUUID(),
        });
        expect(promoted.status).toBe(200);
        expect((await app.api(`review/${id}`)).body).toMatchObject({
          source: kind === 'rule' ? 'rule' : 'gemini',
          reviewedBy: null,
        });
      }
      expect(f.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

it('acknowledges a selected rule nonmatch and preserves saved and pending human evidence', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications.find((item) => item.source === 'table')!;
  const id = licenseKeyDigest(row.normalizedText);
  await writeFile(
    f.input,
    serializeLicenseArtifact(
      recordHumanLicenseDecision(
        f.artifact,
        row.normalizedText,
        'allowed',
        { reviewComment: 'Historic comment' },
        'Historic reviewer',
        '2026-01-01T00:00:00.000Z'
      )
    ).bytes
  );
  const app = await start(f, `--rerun-rule=${id}`);
  try {
    const loaded = await app.operate('inspect');
    expect(loaded.paidEstimate.unmatchedRuleIds).toEqual([id]);
    const historic = (await app.api(`review/${id}`)).body;
    await app.api('review/draft', {
      kind: 'patch',
      mutationId: crypto.randomUUID(),
      epoch: historic.epoch,
      contentRevision: historic.contentRevision,
      id,
      status: 'unknown',
      reviewComment: 'Pending human comment',
      touched: true,
    });
    const before = (await app.api(`review/${id}`)).body;
    expect(before).toMatchObject({ pending: true, reviewComment: 'Pending human comment' });
    const selection = {
      id,
      kind: 'rule',
      operationId: crypto.randomUUID(),
      configurationRevision: loaded.configurationRevision,
      contentRevision: before.contentRevision,
    };
    const result = await app.api('review/rerun', selection);
    expect(result.status).toBe(200);
    expect(result.body.paidEstimate).toMatchObject({
      contentRevision: before.contentRevision,
      selection: { id, kind: 'rule' },
      unmatchedRuleIds: [id],
      expectedUncachedRequests: 0,
      replacements: [],
    });
    expect(await app.api('review/rerun', selection)).toEqual(result);
    expect((await app.api(`review/${id}`)).body).toEqual(before);
    const reverted = await app.api('review/draft', {
      kind: 'revert',
      id,
      mutationId: crypto.randomUUID(),
      epoch: before.epoch,
      contentRevision: before.contentRevision,
    });
    expect(reverted.status).toBe(200);
    expect((await app.api(`review/${id}`)).body).toEqual({
      ...historic,
      contentRevision: reverted.body.contentRevision,
    });
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await f.cleanup();
  }
});
