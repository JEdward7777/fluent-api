import { describe, expect, it } from 'vitest';

import { llmRequestHash } from '@/lib/llm/request-cache';

import type { LicenseArtifact } from './license-artifact.schemas';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  createLicenseArtifact,
} from './license-artifact';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { parseLicenseVote } from './license-model-contract';

interface InvalidMutation {
  name: string;
  edit: (artifact: LicenseArtifact) => void;
}
const invalid: InvalidMutation[] = [
  {
    name: 'duplicate exact key',
    edit: (a) => {
      a.classifications.push(structuredClone(a.classifications[0]));
    },
  },
  {
    name: 'unnormalized exact key',
    edit: (a) => {
      a.classifications[0].normalizedText = 'Copyright 2026 EXTRA';
    },
  },
  {
    name: 'key/example mismatch',
    edit: (a) => {
      a.classifications[0].exampleNotice = 'A different notice';
    },
  },
  {
    name: 'duplicate provider identity',
    edit: (a) => {
      a.catalog[1].externalId = a.catalog[0].externalId;
    },
  },
  {
    name: 'duplicate internal ID',
    edit: (a) => {
      a.catalog[1].bibleId = a.catalog[0].bibleId;
    },
  },
  {
    name: 'uncovered raw notice',
    edit: (a) => {
      a.catalog[0].rawNotice = 'A new unclassified notice';
    },
  },
  {
    name: 'duplicate configured model',
    edit: (a) => {
      a.classificationRun.models.push(structuredClone(a.classificationRun.models[0]));
    },
  },
  {
    name: 'stale prompt hash',
    edit: (a) => {
      a.classificationRun.promptHash = 'f'.repeat(64);
    },
  },
  {
    name: 'duplicate sample index',
    edit: (a) => {
      a.classifications[1].samples[1].index = 1;
    },
  },
  {
    name: 'missing sample',
    edit: (a) => {
      a.classifications[1].samples.pop();
    },
  },
  {
    name: 'out-of-range index',
    edit: (a) => {
      a.classifications[1].samples[0].index = 4;
    },
  },
  {
    name: 'unconfigured sample model',
    edit: (a) => {
      a.classifications[1].samples[0].model = 'other';
    },
  },
  {
    name: 'request metadata mismatch',
    edit: (a) => {
      a.classifications[1].samples[0].request.model = 'other';
    },
  },
  {
    name: 'wrong request hash',
    edit: (a) => {
      a.classifications[1].samples[0].requestHash = 'e'.repeat(64);
    },
  },
  {
    name: 'wrong request claimed under a recomputed request hash',
    edit: (a) => {
      const sample = a.classifications[1].samples[0];
      sample.request.messages[1].content += ' Extra hidden instructions.';
      sample.requestHash = llmRequestHash(sample.request);
    },
  },
  {
    name: 'vote differing from raw response',
    edit: (a) => {
      a.classifications[1].samples[0].result.decision = 'forbidden';
    },
  },
  {
    name: 'rationale differing from raw response',
    edit: (a) => {
      a.classifications[1].samples[0].result.rationale += ' ';
    },
  },
  {
    name: 'invalid structured raw response',
    edit: (a) => {
      a.classifications[1].samples[0].response = 'not JSON';
    },
  },
  {
    name: 'forged allowed status despite mixed model votes',
    edit: (a) => {
      const sample = a.classifications[1].samples[0];
      sample.response = '{"rationale":"The notice prohibits this use.","decision":"forbidden"}';
      sample.result = parseLicenseVote(sample.response);
    },
  },
  {
    name: 'claiming missing samples as unknown',
    edit: (a) => {
      a.classifications[1].status = 'unknown';
      a.classifications[1].samples = [];
    },
  },
  {
    name: 'rule decision mismatch',
    edit: (a) => {
      a.classifications[0].status = 'allowed';
    },
  },
  {
    name: 'rule matched excerpt absent from notice',
    edit: (a) => {
      a.classifications[0].rule!.matchedExcerpt = 'not in the notice';
    },
  },
  {
    name: 'manual disposition missing preserved decision',
    edit: (a) => {
      a.classifications[0].source = 'manual';
    },
  },
  {
    name: 'unexpected model evidence for a table-only row',
    edit: (a) => {
      a.classifications[2].samples = structuredClone(a.classifications[1].samples);
    },
  },
];

describe('artifact owned content validation', () => {
  it.each(invalid)('rejects $name before responsibility can be accepted', ({ edit }) => {
    const artifact = makeLicenseArtifact();
    edit(artifact);
    expect(checkLicenseArtifactReview(artifact).status).toBe('invalid');
    expect(() => attestLicenseArtifact(artifact, REVIEWER)).toThrow();
  });
  it.each(['schemaVersion', 'hashDomainVersion', 'normalizerVersion'])(
    'rejects unsupported %s',
    (field) => {
      expect(checkLicenseArtifactReview({ ...makeLicenseArtifact(), [field]: 2 }).status).toBe(
        'invalid'
      );
    }
  );
  it('rejects invalid enums, blank rationales, blank identities, invalid times and non-JSON extensions', () => {
    const artifact = makeLicenseArtifact();
    expect(
      checkLicenseArtifactReview({
        ...artifact,
        classifications: [{ ...artifact.classifications[0], status: 'maybe' }],
      }).status
    ).toBe('invalid');
    expect(
      checkLicenseArtifactReview({
        ...artifact,
        classifications: [{ ...artifact.classifications[0], rationale: ' ' }],
      }).status
    ).toBe('invalid');
    expect(
      checkLicenseArtifactReview({
        ...artifact,
        catalog: [{ ...artifact.catalog[0], externalId: '' }],
      }).status
    ).toBe('invalid');
    expect(checkLicenseArtifactReview({ ...artifact, extension: () => 'not JSON' }).status).toBe(
      'invalid'
    );
    expect(
      checkLicenseArtifactReview({
        ...artifact,
        catalog: [{ ...artifact.catalog[0], name: '\uD800' }],
      }).status
    ).toBe('invalid');
    expect(
      checkLicenseArtifactReview({
        ...artifact,
        attestation: {
          ...REVIEWER,
          reviewedAt: 'bad',
          reviewContentHash: artifact.reviewContentHash,
        },
      }).status
    ).toBe('invalid');
  });
  it('rejects non-JSON __proto__ extension values instead of silently dropping them', () => {
    const artifact = makeLicenseArtifact();
    const invalid = { ...artifact, ['__proto__']: () => 'not JSON' };
    expect(checkLicenseArtifactReview(invalid).status).toBe('invalid');
    const nested = { ...artifact, extra: { ['__proto__']: { invalid: undefined } } };
    expect(checkLicenseArtifactReview(nested).status).toBe('invalid');
  });

  it('allows null/empty notices and retained rows without current catalog members', () => {
    const base = makeLicenseArtifact();
    const artifact = createLicenseArtifact({
      classificationRun: base.classificationRun,
      classifications: base.classifications,
      catalog: [
        { ...base.catalog[0], rawNotice: null },
        { ...base.catalog[1], rawNotice: ' ' },
      ],
    });
    expect(attestLicenseArtifact(artifact, REVIEWER).classifications).toEqual(base.classifications);
  });
});
