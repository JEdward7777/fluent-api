import { describe, expect, it, vi } from 'vitest';

import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import { createLicenseClassifier } from '../license-classifier';
import { assessedLicenseRow } from './license-assessment';
import { licenseKeyDigest, planLicenseEligibility } from './license-eligibility';
import { inspectLicensePreflight } from './license-preflight';

const artifact = makeLicenseArtifact();
const rows = new Map(artifact.classifications.map((row) => [row.normalizedText, row]));
const notices = artifact.catalog.map((row) => row.rawNotice!);

describe('shared classification eligibility', () => {
  it('previews exact uncached requests for an unreviewed DB unknown and none for JSON import', async () => {
    const database = {
      tableExists: true,
      classifications: artifact.classifications.map((row) => ({
        normalizedText: row.normalizedText,
        status: row.status,
        rationale: row.rationale,
        classifiedBy: null,
        reviewedAt: null,
        evidence: row,
      })),
      context: {
        label: 'Synthetic local DB',
        resources: artifact.catalog.map((row) => ({
          ...row,
          ttsLicenseStatus: 'unknown' as const,
        })),
      },
    };
    const db = await inspectLicensePreflight({
      database,
      model: 'google:fixture',
      sampleCount: 2,
      noCache: true,
    });
    expect(db).toMatchObject({ modelKeys: 1, expectedUncachedRequests: 2, maximumAttempts: 10 });
    expect(
      db.rows.find((row) => row.normalizedText === artifact.classifications[2].normalizedText)
    ).toMatchObject({ action: 'model', reason: 'unreviewed unknown database key' });
    const json = await inspectLicensePreflight({
      jsonClassifications: artifact.classifications,
      jsonNotices: notices,
      model: 'google:fixture',
      sampleCount: 2,
      noCache: true,
    });
    expect(json.expectedUncachedRequests).toBe(0);
    expect(json.modelKeys).toBe(0);
  });
  it('retains all saved decisions by default, including completed unknown and human rows', () => {
    const selected = planLicenseEligibility({
      notices,
      stored: rows,
      source: 'json',
      ruleDigests: [],
      modelDigests: [],
    });
    expect(selected).toHaveLength(3);
    expect(selected.every((row) => row.action === 'retain')).toBe(true);
  });

  it('selects one rule rerun, retains a rule nonmatch, and requires model opt-in for fallback', () => {
    const key = artifact.classifications[2].normalizedText;
    const selected = planLicenseEligibility({
      notices,
      stored: rows,
      source: 'json',
      ruleDigests: [licenseKeyDigest(key)],
      modelDigests: [],
    });
    expect(selected.find((row) => row.normalizedText === key)).toMatchObject({
      action: 'rule',
      ruleMatches: false,
    });
    const fallback = planLicenseEligibility({
      notices,
      stored: rows,
      source: 'json',
      ruleDigests: [licenseKeyDigest(key)],
      modelDigests: [licenseKeyDigest(key)],
    });
    expect(fallback.find((row) => row.normalizedText === key)?.action).toBe('model');
  });

  it('assesses unreviewed unknown DB rows but skips completed LLM and human unknowns', () => {
    const table = artifact.classifications[2];
    const llm = artifact.classifications[1];
    const stored = new Map([
      [table.normalizedText, table],
      [llm.normalizedText, { ...llm, status: 'unknown' as const }],
    ]);
    const planned = planLicenseEligibility({
      notices: [table.exampleNotice, llm.exampleNotice],
      stored,
      source: 'database',
      ruleDigests: [],
      modelDigests: [],
    });
    expect(planned.find((row) => row.normalizedText === table.normalizedText)?.action).toBe(
      'model'
    );
    expect(planned.find((row) => row.normalizedText === llm.normalizedText)?.action).toBe('retain');
    const human = {
      ...table,
      reviewState: 'human_reviewed' as const,
      reviewedBy: 'Named reviewer',
      humanReviewedAt: '2026-11-17T12:00:00.000Z',
      decisionAt: '2026-11-17T12:00:00.000Z',
    };
    const protectedRows = planLicenseEligibility({
      notices: [table.exampleNotice],
      stored: new Map([[table.normalizedText, human]]),
      source: 'database',
      ruleDigests: [],
      modelDigests: [],
    });
    expect(protectedRows[0].action).toBe('retain');
  });

  it('rejects a selected digest absent from the inspected key set', () => {
    expect(() =>
      planLicenseEligibility({
        notices,
        stored: rows,
        source: 'json',
        ruleDigests: ['0'.repeat(64)],
        modelDigests: [],
      })
    ).toThrow('absent from source');
  });

  it('does not let a rule rerun demote an LLM or human decision', () => {
    const model = artifact.classifications[1];
    expect(() =>
      planLicenseEligibility({
        notices: [model.exampleNotice],
        stored: new Map([[model.normalizedText, model]]),
        source: 'json',
        ruleDigests: [licenseKeyDigest(model.normalizedText)],
        modelDigests: [],
      })
    ).toThrow('requires an unreviewed row');
  });
});

describe('actual assessment event time', () => {
  it('dates each successful rule firing, including an identical deliberate reevaluation', async () => {
    const classifier = createLicenseClassifier({
      apiKey: 'fixture',
      model: 'google:fixture',
      transport: vi.fn(async () => {
        throw new Error('Rule should prevent transport');
      }),
    });
    const original = artifact.classifications[0];
    const proposal = await classifier(original.exampleNotice);
    const first = assessedLicenseRow({
      normalizedText: original.normalizedText,
      exampleNotice: original.exampleNotice,
      proposal,
      previous: original,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T12:00:00.000Z',
    });
    const second = assessedLicenseRow({
      normalizedText: original.normalizedText,
      exampleNotice: original.exampleNotice,
      proposal,
      previous: first,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T13:00:00.000Z',
    });
    expect(first.decisionAt).toBe('2026-11-17T12:00:00.000Z');
    expect(second.decisionAt).toBe('2026-11-17T13:00:00.000Z');
  });

  it('keeps an identical cached model replay undated without a known original event', async () => {
    const classifier = createLicenseClassifier({
      apiKey: 'fixture',
      model: 'google:fixture',
      sampleCount: 2,
      noCache: true,
      transport: vi.fn(async () => JSON.stringify({ rationale: 'Unclear.', decision: 'unknown' })),
    });
    const notice = 'Unclear license terms.';
    const proposal = await classifier(notice, undefined, 'model-only');
    if (proposal.source !== 'gemini') throw new Error('Expected model proposal');
    const previous = assessedLicenseRow({
      normalizedText: proposal.normalizedText,
      exampleNotice: notice,
      proposal,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T12:00:00.000Z',
    });
    expect(previous.decisionAt).toBe('2026-11-17T12:00:00.000Z');
    const replay = {
      ...proposal,
      samples: proposal.samples.map((sample) => ({ ...sample, cacheHit: true })),
    };
    const same = assessedLicenseRow({
      normalizedText: proposal.normalizedText,
      exampleNotice: notice,
      proposal: replay,
      previous,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T13:00:00.000Z',
    });
    expect(same.decisionAt).toBe(previous.decisionAt);
    const unknownOriginal = assessedLicenseRow({
      normalizedText: proposal.normalizedText,
      exampleNotice: notice,
      proposal: replay,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T13:00:00.000Z',
    });
    expect(unknownOriginal.decisionAt).toBeNull();
    const human = {
      ...previous,
      source: 'manual' as const,
      reviewState: 'human_reviewed' as const,
      reviewedBy: 'Human',
      humanReviewedAt: '2026-11-17T14:00:00.000Z',
      decisionAt: '2026-11-17T14:00:00.000Z',
      automaticDecision: {
        source: 'gemini' as const,
        status: previous.status,
        rationale: previous.rationale,
      },
    };
    const demoted = assessedLicenseRow({
      normalizedText: proposal.normalizedText,
      exampleNotice: notice,
      proposal: replay,
      previous: human,
      classificationRun: artifact.classificationRun,
      now: () => '2026-11-17T15:00:00.000Z',
    });
    expect(demoted.reviewState).toBe('llm_reviewed');
    expect(demoted.decisionAt).toBeNull();
    expect(demoted.reviewedBy).toBeNull();
  });
});
