import { describe, expect, it, vi } from 'vitest';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  reviseLicenseArtifact,
} from '../license-artifact';
import {
  makeLicenseArtifact,
  makeLicenseNoteRefreshFixture,
  REVIEWER,
} from '../license-artifact.test-fixtures';
import { createLicenseClassifier } from '../license-classifier';
import { buildLicenseSampleRequest } from '../license-model-contract';
import { analyzeDatabaseLicenses } from './license-analysis';
import { licenseDatabaseProjection } from './license-database-projection';

function storedRows(artifact: ReturnType<typeof makeLicenseArtifact>) {
  return licenseDatabaseProjection(artifact).map((row) => ({
    normalizedText: row.normalizedText,
    status: row.status,
    rationale: row.rationale.text,
    classifiedBy: row.classifiedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    evidence: row.rationale.evidence,
    classificationRun: row.rationale.classificationRun,
  }));
}

describe('database refresh and recorded evidence contracts', () => {
  it('preserves historical prompts, models, sample counts and extensions while classifying only new keys with current configuration', async () => {
    let old = makeLicenseArtifact();
    old = reviseLicenseArtifact(old, (draft) => {
      draft.classificationRun.prompt = `Historical task prompt. ${draft.classificationRun.prompt}`;
      draft.classificationRun.promptHash = hashCanonicalJson(draft.classificationRun.prompt);
      draft.classificationRun.models.forEach((model) => {
        model.sampleCount = 2;
      });
      for (const row of draft.classifications) {
        row.samples = row.samples
          .filter((sample) => sample.index <= 2)
          .map((sample) => {
            const model = draft.classificationRun.models.find(
              (model) => model.model === sample.model
            )!;
            const request = buildLicenseSampleRequest(
              row.exampleNotice,
              sample.provider,
              sample.model,
              sample.index,
              {
                prompt: draft.classificationRun.prompt,
                responseSchema: draft.classificationRun.responseSchema,
                settings: model.settings,
              }
            );
            return { ...sample, request, requestHash: llmRequestHash(request) };
          });
      }
      draft.extension = { retained: true };
      draft.classifications[1].extension = { historical: true };
    });
    old = attestLicenseArtifact(old, REVIEWER);
    const transport = vi.fn(
      async () => '{"rationale":"Allowed by these fixture terms.","decision":"allowed"}'
    );
    const classify = createLicenseClassifier({
      apiKey: 'mock',
      model: 'google:new-model',
      sampleCount: 3,
      noCache: true,
      transport,
    });
    const artifact = await analyzeDatabaseLicenses({
      base: old,
      classifications: storedRows(old),
      catalog: [
        ...old.catalog,
        {
          provider: 'aquifer',
          externalId: 'fresh',
          bibleId: 100,
          name: 'Fresh',
          abbreviation: 'F',
          rawNotice: 'A unique new licensing statement.',
        },
      ],
      classify,
      model: 'google:new-model',
      sampleCount: 3,
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.hashDomainVersion).toBe(2);
    expect(artifact.classificationRun.models[0].model).toBe('new-model');
    const retained = artifact.classifications.find(
      (row) =>
        row.source === 'gemini' && row.normalizedText === old.classifications[1].normalizedText
    )!;
    expect(
      retained.samples.map(({ attempts: _attempts, cacheHit: _cacheHit, ...sample }) => sample)
    ).toEqual(
      old.classifications[1].samples.map(
        ({ attempts: _attempts, cacheHit: _cacheHit, ...sample }) => sample
      )
    );
    expect(retained.evidenceContract?.prompt).toBe(old.classificationRun.prompt);
    expect(retained.extension).toEqual({ historical: true });
    expect(artifact.extension).toEqual({ retained: true });
    expect(artifact.attestation).toBeUndefined();
    expect(checkLicenseArtifactReview(artifact).status).toBe('review-required');
    const projection = licenseDatabaseProjection(artifact).find(
      (row) => row.normalizedText === retained.normalizedText
    )!;
    expect(projection.classifiedBy).toBe('google:recorded-model-a,google:recorded-model-b');
    expect(projection.rationale.classificationRun!.prompt).toBe(old.classificationRun.prompt);
    expect(projection.rationale.evidence).not.toHaveProperty('extension');
    expect(projection.rationale.evidence.evidenceContract?.prompt).toBe(
      retained.evidenceContract?.prompt
    );
    expect(projection.rationale.evidence.evidenceContract).not.toHaveProperty('createdAt');
  });
  it('retains authoritative unknown without inference, and clears stale evidence/human notes on a changed DB decision', async () => {
    const base = makeLicenseArtifact();
    const rows = storedRows(base);
    rows[1].status = 'forbidden';
    rows[1].rationale = 'Database decision changed';
    const transport = vi.fn();
    const artifact = await analyzeDatabaseLicenses({
      base,
      classifications: rows,
      catalog: base.catalog,
      classify: createLicenseClassifier({ apiKey: 'mock', transport }),
      model: 'google:current',
      sampleCount: 3,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(
      artifact.classifications.find((row) => row.normalizedText === rows[1].normalizedText)
    ).toMatchObject({ source: 'table', status: 'forbidden', samples: [] });
    expect(
      artifact.classifications.find((row) => row.normalizedText === rows[2].normalizedText)?.status
    ).toBe('unknown');
    expect(artifact.attestation).toBeUndefined();
  });
  it('makes per-row contract edits owned and independently validates prompt/schema/request/sample identity', async () => {
    const artifact = makeLicenseArtifact();
    artifact.classifications[1].evidenceContract = structuredClone(artifact.classificationRun);
    const valid = reviseLicenseArtifact(artifact, () => {});
    const changed = structuredClone(valid);
    changed.classifications[1].evidenceContract!.models[0].sampleCount++;
    expect(checkLicenseArtifactReview(changed).status).toBe('invalid');
    changed.classifications[1].evidenceContract = structuredClone(valid.classificationRun);
    changed.classifications[1].evidenceContract!.prompt += ' altered';
    expect(checkLicenseArtifactReview(changed).status).toBe('invalid');
    const owned = reviseLicenseArtifact(valid, (draft) => {
      draft.classifications[1].evidenceContract!.ruleSetHash = 'a'.repeat(64);
    });
    expect(owned.reviewContentHash).not.toBe(valid.reviewContentHash);
  });
  it('uses newer owned DB evidence rather than an older JSON base, preserving only base extensions', async () => {
    const base = makeLicenseArtifact();
    base.classifications[1] = {
      ...base.classifications[1],
      extension: { keep: true },
      ...JSON.parse('{"__proto__":{"keep":true},"constructor":"opaque extension"}'),
    };
    const stored = storedRows(base);
    const evidence = stored[1].evidence;
    evidence.samples[0].result.rationale = 'Newer database vote rationale.';
    evidence.samples[0].response = JSON.stringify(evidence.samples[0].result);
    const transport = vi.fn();
    const result = await analyzeDatabaseLicenses({
      base,
      classifications: stored,
      catalog: base.catalog,
      classify: createLicenseClassifier({ apiKey: 'mock', transport }),
      model: 'google:current',
      sampleCount: 3,
    });
    const row = result.classifications.find(
      (row) => row.normalizedText === evidence.normalizedText
    )!;
    expect(row.samples[0].response).toBe(evidence.samples[0].response);
    expect(row.samples[0].response).not.toBe(base.classifications[1].samples[0].response);
    expect(row.extension).toEqual({ keep: true });
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(row.constructor).toBe('opaque extension');
    expect(Object.hasOwn(Object.prototype, 'keep')).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps authoritative current DB notes even when stale JSON has the same literal note attached to a different decision', async () => {
    const { stale, current, note } = makeLicenseNoteRefreshFixture();
    const transport = vi.fn();
    const classify = createLicenseClassifier({ apiKey: 'mock', transport });
    const input = {
      catalog: current.catalog,
      classifications: storedRows(current),
      classify,
      model: 'google:current',
      sampleCount: 3,
    };
    const withoutBase = await analyzeDatabaseLicenses(input);
    const withBase = await analyzeDatabaseLicenses({ ...input, base: stale });
    expect(
      withBase.classifications.find(
        (row) => row.normalizedText === current.classifications[1].normalizedText
      )?.rowNote
    ).toBe(note);
    expect(licenseDatabaseProjection(withBase)).toEqual(licenseDatabaseProjection(withoutBase));
    expect(withBase.attestation).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains an exact matching top-level attestation when only a validated database refresh is repeated', async () => {
    const { current } = makeLicenseNoteRefreshFixture();
    const transport = vi.fn();
    const classify = createLicenseClassifier({ apiKey: 'mock', transport });
    const input = {
      catalog: current.catalog,
      classifications: storedRows(current),
      classify,
      model: 'google:current',
      sampleCount: 3,
    };
    const first = attestLicenseArtifact(await analyzeDatabaseLicenses(input), REVIEWER);
    const repeated = await analyzeDatabaseLicenses({ ...input, base: first });
    expect(repeated.reviewContentHash).toBe(first.reviewContentHash);
    expect(repeated.attestation).toEqual(first.attestation);
    expect(checkLicenseArtifactReview(repeated).status).toBe('ready');
    expect(transport).not.toHaveBeenCalled();
  });
});
