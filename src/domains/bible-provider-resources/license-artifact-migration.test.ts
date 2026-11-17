import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { checkLicenseArtifactReview, serializeLicenseArtifact } from './license-artifact';
import { LICENSE_CLASSIFICATIONS_PATH, parseLicenseArtifact } from './license-artifact.schemas';

describe('tracked v2 candidate migration', () => {
  it('upgrades validated evidence in memory without touching source bytes', async () => {
    const before = await readFile(LICENSE_CLASSIFICATIONS_PATH);
    const beforeHash = createHash('sha256').update(before).digest('hex');
    const legacy: unknown = JSON.parse(before.toString('utf8'));
    const upgraded = parseLicenseArtifact(legacy);
    const checked = checkLicenseArtifactReview(upgraded);
    expect(checked.status === 'invalid' ? checked.reason : 'valid').toBe('valid');
    expect(upgraded.schemaVersion).toBe(3);
    expect(upgraded.hashDomainVersion).toBe(3);
    expect(upgraded.classifications).toHaveLength(523);
    expect(new Set(upgraded.classifications.map((row) => row.normalizedText)).size).toBe(523);
    expect(upgraded.classifications.filter((row) => row.status === 'unknown')).toHaveLength(294);
    const modelRows = upgraded.classifications.filter((row) => row.source === 'gemini');
    expect(modelRows).toHaveLength(300);
    expect(
      modelRows.every((row) => row.reviewState === 'llm_reviewed' && row.samples.length > 0)
    ).toBe(true);
    expect(
      upgraded.classifications.every(
        (row) => row.decisionAt === null && row.reviewedBy === null && row.humanReviewedAt === null
      )
    ).toBe(true);
    expect(upgraded.attestation).toBeUndefined();
    const roundTrip = parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(upgraded).bytes));
    expect(roundTrip.reviewContentHash).toBe(upgraded.reviewContentHash);
    const after = await readFile(LICENSE_CLASSIFICATIONS_PATH);
    expect(after.equals(before)).toBe(true);
    expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash);
  }, 20000);
});
