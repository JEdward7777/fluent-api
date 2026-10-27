import { describe, expect, it } from 'vitest';

import type { LicenseArtifact } from './license-artifact.schemas';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  overrideLicenseClassification,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from './license-artifact';
import { computeLicenseReviewHash } from './license-artifact.hash';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';

interface OwnedMutation {
  name: string;
  edit: (artifact: LicenseArtifact) => void;
}
const mutations: OwnedMutation[] = [
  {
    name: 'actual prompt',
    edit: (a) => {
      a.classificationRun.prompt += ' ';
    },
  },
  {
    name: 'prompt hash',
    edit: (a) => {
      a.classificationRun.promptHash = 'a'.repeat(64);
    },
  },
  {
    name: 'rule-set hash',
    edit: (a) => {
      a.classificationRun.ruleSetHash = 'b'.repeat(64);
    },
  },
  {
    name: 'run response schema',
    edit: (a) => {
      a.classificationRun.responseSchema.description = 'Changed schema';
    },
  },
  {
    name: 'model provider',
    edit: (a) => {
      a.classificationRun.models[0].provider = 'another-provider';
    },
  },
  {
    name: 'actual model ID',
    edit: (a) => {
      a.classificationRun.models[0].model += '-changed';
    },
  },
  {
    name: 'sample configuration',
    edit: (a) => {
      a.classificationRun.models[0].sampleCount++;
    },
  },
  {
    name: 'inference settings',
    edit: (a) => {
      a.classificationRun.models[0].settings.temperature = 0.5;
    },
  },
  {
    name: 'Bible provider',
    edit: (a) => {
      a.catalog[0].provider = 'aquifer';
    },
  },
  {
    name: 'external identity',
    edit: (a) => {
      a.catalog[0].externalId += '-changed';
    },
  },
  {
    name: 'internal Bible ID',
    edit: (a) => {
      a.catalog[0].bibleId = 99;
    },
  },
  {
    name: 'Bible name',
    edit: (a) => {
      a.catalog[0].name += ' ';
    },
  },
  {
    name: 'Bible abbreviation',
    edit: (a) => {
      a.catalog[0].abbreviation += '-new';
    },
  },
  {
    name: 'raw catalog notice',
    edit: (a) => {
      a.catalog[0].rawNotice += ' ';
    },
  },
  {
    name: 'catalog membership',
    edit: (a) => {
      a.catalog.pop();
    },
  },
  {
    name: 'normalized key',
    edit: (a) => {
      a.classifications[0].normalizedText += '-new';
    },
  },
  {
    name: 'example notice',
    edit: (a) => {
      a.classifications[0].exampleNotice += ' ';
    },
  },
  {
    name: 'classification status',
    edit: (a) => {
      a.classifications[0].status = 'unknown';
    },
  },
  {
    name: 'classification source',
    edit: (a) => {
      a.classifications[0].source = 'table';
    },
  },
  {
    name: 'classification rationale whitespace',
    edit: (a) => {
      a.classifications[0].rationale += ' ';
    },
  },
  {
    name: 'human row-note whitespace',
    edit: (a) => {
      a.classifications[2].rowNote += ' ';
    },
  },
  {
    name: 'rule identity',
    edit: (a) => {
      a.classifications[0].rule!.id += '-changed';
    },
  },
  {
    name: 'rule priority',
    edit: (a) => {
      a.classifications[0].rule!.priority++;
    },
  },
  {
    name: 'rule decision',
    edit: (a) => {
      a.classifications[0].rule!.decision = 'unknown';
    },
  },
  {
    name: 'rule rationale',
    edit: (a) => {
      a.classifications[0].rule!.rationale += ' ';
    },
  },
  {
    name: 'matched rule excerpt',
    edit: (a) => {
      a.classifications[0].rule!.matchedExcerpt += '.';
    },
  },
  {
    name: 'sample index',
    edit: (a) => {
      a.classifications[1].samples[0].index++;
    },
  },
  {
    name: 'sample provider',
    edit: (a) => {
      a.classifications[1].samples[0].provider += '-changed';
    },
  },
  {
    name: 'sample model',
    edit: (a) => {
      a.classifications[1].samples[0].model += '-changed';
    },
  },
  {
    name: 'request hash',
    edit: (a) => {
      a.classifications[1].samples[0].requestHash = 'c'.repeat(64);
    },
  },
  {
    name: 'outbound request provider',
    edit: (a) => {
      a.classifications[1].samples[0].request.provider += '-changed';
    },
  },
  {
    name: 'outbound request model',
    edit: (a) => {
      a.classifications[1].samples[0].request.model += '-changed';
    },
  },
  {
    name: 'outbound message role',
    edit: (a) => {
      a.classifications[1].samples[0].request.messages[0].role = 'user';
    },
  },
  {
    name: 'outbound prompt content',
    edit: (a) => {
      a.classifications[1].samples[0].request.messages[0].content += ' ';
    },
  },
  {
    name: 'outbound message ordering',
    edit: (a) => {
      a.classifications[1].samples[0].request.messages.reverse();
    },
  },
  {
    name: 'outbound response schema',
    edit: (a) => {
      a.classifications[1].samples[0].request.responseSchema.description = 'Changed';
    },
  },
  {
    name: 'outbound inference settings',
    edit: (a) => {
      a.classifications[1].samples[0].request.settings.temperature = 0.1;
    },
  },
  {
    name: 'raw model response',
    edit: (a) => {
      a.classifications[1].samples[0].response += ' ';
    },
  },
  {
    name: 'parsed model decision',
    edit: (a) => {
      a.classifications[1].samples[0].result.decision = 'unknown';
    },
  },
  {
    name: 'parsed model rationale whitespace',
    edit: (a) => {
      a.classifications[1].samples[0].result.rationale += ' ';
    },
  },
  {
    name: 'classification membership',
    edit: (a) => {
      a.classifications.pop();
    },
  },
];

describe('owned review content hash domain', () => {
  it.each(mutations)('includes $name and never leaves its old attestation ready', ({ edit }) => {
    const original = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const changed = structuredClone(original);
    edit(changed);
    expect(computeLicenseReviewHash(changed)).not.toBe(original.reviewContentHash);
    expect(checkLicenseArtifactReview(changed).status).not.toBe('ready');
  });
  it('is permutation-independent for catalog, decision, model and sample sets without mutating inputs', () => {
    const original = makeLicenseArtifact();
    const before = structuredClone(original);
    const reversed = structuredClone(original);
    reversed.catalog.reverse();
    reversed.classifications.reverse();
    reversed.classificationRun.models.reverse();
    for (const row of reversed.classifications) row.samples.reverse();
    expect(computeLicenseReviewHash(reversed)).toBe(original.reviewContentHash);
    expect(original).toEqual(before);
  });
  it('includes every part of a preserved automatic decision under manual override', () => {
    const base = makeLicenseArtifact();
    const artifact = overrideLicenseClassification(
      base,
      base.classifications[0].normalizedText,
      'allowed',
      'Explicit rights-holder permission.'
    ).artifact;
    for (const field of ['status', 'rationale', 'source'] as const) {
      const changed = structuredClone(artifact);
      const automatic = changed.classifications[0].automaticDecision!;
      if (field === 'status') automatic.status = 'unknown';
      else if (field === 'source') automatic.source = 'table';
      else automatic.rationale += ' ';
      expect(computeLicenseReviewHash(changed)).not.toBe(artifact.reviewContentHash);
    }
  });
  it('excludes attestation, markers, stored digest, volatile times, diagnostics and unconsumed extensions', () => {
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const changed = structuredClone(artifact);
    changed.reviewContentHash = 'd'.repeat(64);
    changed.reviewState = 'incomplete';
    changed.attestation = {
      ...REVIEWER,
      reviewedBy: 'Another named reviewer',
      reviewedAt: '2026-11-01T00:00:00.000Z',
      reviewReason: 'Another explicit review.',
      reviewContentHash: 'e'.repeat(64),
    };
    changed.classificationRun.createdAt = '2026-11-01T00:00:00.000Z';
    changed.classificationRun.snapshotAt = '2026-10-26T00:00:00.000Z';
    changed.classificationRun.acquiredAt = '2026-10-27T01:00:00.000Z';
    changed.extension = { any: ['unconsumed'] };
    changed.classificationRun.models[0].extension = 'outside semantics';
    changed.classifications[0].extension = { status: 'allowed' }; // cannot override owned status
    changed.classifications[1].samples[0].cacheHit = true;
    changed.classifications[1].samples[0].attempts = 5;
    changed.classifications[1].samples[0].extension = 'unconsumed';
    expect(computeLicenseReviewHash(changed)).toBe(artifact.reviewContentHash);
  });
  it('keeps the exact attestation valid across diagnostic-only edits while changing file bytes', () => {
    const original = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const changed = reviseLicenseArtifact(original, (draft) => {
      draft.classifications[1].samples[0].cacheHit = true;
      draft.classifications[1].samples[0].attempts = 0;
      draft.classificationRun.createdAt = '2026-11-01T00:00:00.000Z';
    });
    expect(checkLicenseArtifactReview(changed).status).toBe('ready');
    expect(changed.attestation).toEqual(original.attestation);
    expect(serializeLicenseArtifact(changed).wholeFileHash).not.toBe(
      serializeLicenseArtifact(original).wholeFileHash
    );
  });
});
