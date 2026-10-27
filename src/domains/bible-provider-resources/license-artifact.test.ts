import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  createLicenseArtifact,
  overrideLicenseClassification,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from './license-artifact';
import { computeLicenseReviewHash } from './license-artifact.hash';
import { LICENSE_CLASSIFICATIONS_PATH, parseLicenseArtifact } from './license-artifact.schemas';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { buildLicenseSampleRequest } from './license-model-contract';

describe('versioned license artifact lifecycle', () => {
  it('creates incomplete candidates without inventing a reviewer or file hash', () => {
    const artifact = makeLicenseArtifact();
    expect(LICENSE_CLASSIFICATIONS_PATH).toBe(
      'docs/features/tts-license-ingestion/reference/license-classifications.json'
    );
    expect(artifact.reviewState).toBe('incomplete');
    expect(artifact.attestation).toBeUndefined();
    expect(checkLicenseArtifactReview(artifact).status).toBe('review-required');
    expect(artifact).not.toHaveProperty('wholeFileHash');
    expect(
      createLicenseArtifact({
        ...artifact,
        attestation: { ...REVIEWER, reviewContentHash: artifact.reviewContentHash },
      }).attestation
    ).toBeUndefined();
  });
  it('attests exact content with explicit identity/reason/time and removes the marker', () => {
    const candidate = makeLicenseArtifact();
    const artifact = attestLicenseArtifact(candidate, REVIEWER);
    expect(checkLicenseArtifactReview(artifact).status).toBe('ready');
    expect(artifact.attestation).toEqual({
      ...REVIEWER,
      reviewContentHash: artifact.reviewContentHash,
    });
    expect(artifact).not.toHaveProperty('reviewState');
    expect(candidate.reviewState).toBe('incomplete');
  });
  it.each([
    { ...REVIEWER, reviewedBy: ' ' },
    { ...REVIEWER, reviewReason: '' },
    { ...REVIEWER, reviewedAt: 'invalid' },
  ])('requires valid named attestation metadata %j', (metadata) => {
    expect(() => attestLicenseArtifact(makeLicenseArtifact(), metadata)).toThrow();
  });
  it('retains authoritative table unknowns but requires a human note to complete them', () => {
    const artifact = makeLicenseArtifact();
    delete artifact.classifications[2].rowNote;
    artifact.reviewContentHash = computeLicenseReviewHash(artifact);
    expect(checkLicenseArtifactReview(artifact)).toMatchObject({ status: 'review-required' });
    expect(() => attestLicenseArtifact(artifact, REVIEWER)).toThrow('human row note');
    const noted = reviseLicenseArtifact(artifact, (draft) => {
      draft.classifications[2].rowNote = 'The named reviewer retains unknown.';
    });
    expect(attestLicenseArtifact(noted, REVIEWER).classifications[2]).toMatchObject({
      source: 'table',
      status: 'unknown',
      samples: [],
    });
  });
  it('revokes attestation on owned edits while retaining unconsumed extensions', () => {
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const edited = reviseLicenseArtifact(artifact, (draft) => {
      draft.catalog[0].name = 'Renamed Bible';
      draft.extension = { preserved: true };
    });
    expect(edited.reviewContentHash).not.toBe(artifact.reviewContentHash);
    expect(edited.attestation).toBeUndefined();
    expect(edited.reviewState).toBe('incomplete');
    expect(edited.extension).toEqual({ preserved: true });
    expect(artifact.catalog[0].name).toBe('Bible 1');
  });
  it('preserves extensions in round trips and extension-only revisions without changing review', () => {
    const original = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const changed = reviseLicenseArtifact(original, (draft) => {
      draft.extension = { nested: ['unconsumed', { flag: true }] };
      draft.classifications[0].vendor = { note: 'outside owned semantics' };
      draft.catalog[0].extra = { retained: true };
    });
    expect(changed.reviewContentHash).toBe(original.reviewContentHash);
    expect(changed.attestation).toEqual(original.attestation);
    expect(checkLicenseArtifactReview(changed).status).toBe('ready');
    const roundTrip = parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(changed).bytes));
    expect(roundTrip).toEqual(changed);
    const cloned = parseLicenseArtifact(roundTrip);
    cloned.extension = { replaced: true };
    expect(roundTrip.extension).toEqual({ nested: ['unconsumed', { flag: true }] });
    expect(cloned.classifications[0].vendor).not.toBe(roundTrip.classifications[0].vendor);
  });
  it('round-trips JSON-owned __proto__ extension keys without losing data or changing prototypes', () => {
    const original = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const extensions = {
      ...original,
      ['__proto__']: { topExtension: true },
      nestedExtension: { ['__proto__']: { nested: true } },
      classifications: original.classifications.map((row) => ({
        ...row,
        ['__proto__']: { entryExtension: true },
        nestedExtension: { ['__proto__']: ['retained'] },
      })),
    };
    const external: unknown = JSON.parse(JSON.stringify(extensions));
    const parsed = parseLicenseArtifact(external);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.classifications[0], '__proto__')).toBe(true);
    expect(parsed.nestedExtension).toEqual({ ['__proto__']: { nested: true } });
    expect(parsed.classifications[0].nestedExtension).toEqual({ ['__proto__']: ['retained'] });
    expect(computeLicenseReviewHash(parsed)).toBe(original.reviewContentHash);
    expect(checkLicenseArtifactReview(parsed).status).toBe('ready');
    expect(JSON.parse(serializeLicenseArtifact(parsed).bytes)).toEqual(extensions);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.classifications[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'topExtension')).toBe(false);
  });

  it('retains and hashes JSON-owned __proto__ keys inside request settings and response schemas', () => {
    const original = makeLicenseArtifact();
    const owned = structuredClone(original);
    owned.classificationRun.responseSchema = {
      ...owned.classificationRun.responseSchema,
      ['__proto__']: { schemaMeaning: true },
    };
    for (const model of owned.classificationRun.models)
      model.settings = { ...model.settings, ['__proto__']: { inferenceMeaning: true } };
    for (const sample of owned.classifications[1].samples) {
      const model = owned.classificationRun.models.find(
        (model) => model.provider === sample.provider && model.model === sample.model
      )!;
      sample.request = buildLicenseSampleRequest(
        owned.classifications[1].exampleNotice,
        model.provider,
        model.model,
        sample.index,
        {
          prompt: owned.classificationRun.prompt,
          responseSchema: owned.classificationRun.responseSchema,
          settings: model.settings,
        }
      );
      sample.requestHash = llmRequestHash(sample.request);
    }
    owned.reviewContentHash = computeLicenseReviewHash(owned);
    expect(owned.reviewContentHash).not.toBe(original.reviewContentHash);
    const external: unknown = JSON.parse(JSON.stringify(owned));
    const parsed = parseLicenseArtifact(external);
    expect(Object.hasOwn(parsed.classificationRun.responseSchema, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.classificationRun.models[0].settings, '__proto__')).toBe(true);
    expect(computeLicenseReviewHash(parsed)).toBe(owned.reviewContentHash);
    expect(checkLicenseArtifactReview(attestLicenseArtifact(parsed, REVIEWER)).status).toBe(
      'ready'
    );
    expect(JSON.parse(serializeLicenseArtifact(parsed).bytes)).toEqual(owned);
    expect(Object.getPrototypeOf(parsed.classificationRun.responseSchema)).toBe(Object.prototype);
  });

  it('revokes stale exact revision bindings and makes coherent external edits explicitly reviewable', () => {
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    artifact.catalog[0].name += ' (externally edited)';
    const checked = checkLicenseArtifactReview(artifact);
    expect(checked.status).toBe('review-required');
    if (checked.status !== 'review-required') return;
    expect(checked.artifact.attestation).toBeUndefined();
    expect(checked.artifact.reviewContentHash).not.toBe(artifact.reviewContentHash);
    expect(checked.artifact.reviewState).toBe('incomplete');
    expect(
      checkLicenseArtifactReview(attestLicenseArtifact(checked.artifact, REVIEWER)).status
    ).toBe('ready');
    const wrongBinding = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    wrongBinding.attestation!.reviewContentHash = 'f'.repeat(64);
    expect(checkLicenseArtifactReview(wrongBinding).status).toBe('review-required');
  });
  it('preserves automatic ARR evidence under a reasoned human override', () => {
    const original = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    expect(() =>
      overrideLicenseClassification(
        original,
        original.classifications[0].normalizedText,
        'allowed',
        ' '
      )
    ).toThrow('nonempty rationale');
    const { artifact, warning } = overrideLicenseClassification(
      original,
      original.classifications[0].normalizedText,
      'allowed',
      'Explicit rights-holder permission was reviewed.'
    );
    expect(warning).toContain('all-rights-reserved');
    expect(artifact.classifications[0]).toMatchObject({
      source: 'manual',
      status: 'allowed',
      automaticDecision: {
        source: 'rule',
        status: 'forbidden',
        rationale: original.classifications[0].rationale,
      },
      rule: original.classifications[0].rule,
    });
    expect(artifact.attestation).toBeUndefined();
    expect(checkLicenseArtifactReview(attestLicenseArtifact(artifact, REVIEWER)).status).toBe(
      'ready'
    );
  });
  it('preserves original model samples through manual disagreement and repeated edits', () => {
    const original = makeLicenseArtifact();
    const first = overrideLicenseClassification(
      original,
      original.classifications[1].normalizedText,
      'unknown',
      'Ambiguity needs further review.'
    ).artifact;
    expect(first.classifications[1].samples).toEqual(original.classifications[1].samples);
    expect(first.classifications[1].rowNote).toBe('Ambiguity needs further review.');
    const next = overrideLicenseClassification(
      first,
      first.classifications[1].normalizedText,
      'forbidden',
      'A later explicit review rejects this use.'
    ).artifact;
    expect(next.classifications[1].automaticDecision?.status).toBe('allowed');
    expect(next.classifications[1].rowNote).toBeUndefined();
    expect(next.classifications[1].samples).toEqual(original.classifications[1].samples);
  });
  it('clears stale human notes and model evidence when refreshing a changed database decision', () => {
    const reviewed = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const refreshed = reviseLicenseArtifact(reviewed, (draft) => {
      draft.classifications[2].status = 'allowed';
      draft.classifications[2].rationale = 'Updated authoritative table reason.';
      draft.classifications[1].source = 'table';
      draft.classifications[1].rationale = 'Replacement authoritative table decision.';
    });
    expect(refreshed.classifications[2].rowNote).toBeUndefined();
    expect(refreshed.classifications[1].samples).toEqual([]);
    expect(refreshed.attestation).toBeUndefined();
  });
  it('validates recorded historical prompt/model evidence rather than substituting current defaults', () => {
    const artifact = makeLicenseArtifact();
    artifact.classificationRun.prompt += '\nHistorical reviewed instruction.';
    artifact.classificationRun.promptHash = hashCanonicalJson(artifact.classificationRun.prompt);
    for (const sample of artifact.classifications[1].samples) {
      const model = artifact.classificationRun.models.find(
        (model) => model.provider === sample.provider && model.model === sample.model
      )!;
      sample.request = buildLicenseSampleRequest(
        artifact.classifications[1].exampleNotice,
        model.provider,
        model.model,
        sample.index,
        {
          prompt: artifact.classificationRun.prompt,
          responseSchema: artifact.classificationRun.responseSchema,
          settings: model.settings,
        }
      );
      sample.requestHash = llmRequestHash(sample.request);
    }
    artifact.reviewContentHash = computeLicenseReviewHash(artifact);
    expect(checkLicenseArtifactReview(attestLicenseArtifact(artifact, REVIEWER)).status).toBe(
      'ready'
    );
  });
  it('returns a separate whole-file hash over final bytes without self-reference', () => {
    const { bytes, wholeFileHash } = serializeLicenseArtifact(makeLicenseArtifact());
    expect(wholeFileHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.parse(bytes)).not.toHaveProperty('wholeFileHash');
    expect(bytes.endsWith('\n')).toBe(true);
  });
});
