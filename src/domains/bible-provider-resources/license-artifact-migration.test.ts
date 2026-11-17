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
    expect(upgraded.historicalAttestation).toBeUndefined();
    const roundTrip = parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(upgraded).bytes));
    expect(roundTrip.reviewContentHash).toBe(upgraded.reviewContentHash);
    const after = await readFile(LICENSE_CLASSIFICATIONS_PATH);
    expect(after.equals(before)).toBe(true);
    expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash);
  }, 20000);

  it('retains a valid v2 assertion only as historical metadata', async () => {
    const before = await readFile(LICENSE_CLASSIFICATIONS_PATH);
    const legacy = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    const v2Hash = legacy.reviewContentHash as string;
    legacy.attestation = {
      reviewedBy: 'Historical reviewer',
      reviewReason: 'Reviewed the original v2 content',
      reviewedAt: '2026-10-27T00:00:00.000Z',
      reviewContentHash: v2Hash,
    };
    const upgraded = parseLicenseArtifact(legacy);
    expect(upgraded.attestation).toBeUndefined();
    expect(checkLicenseArtifactReview(upgraded).status).toBe('review-required');
    expect(upgraded.historicalAttestation).toEqual({
      schemaVersion: 2,
      hashDomainVersion: 2,
      ...(legacy.attestation as object),
    });
    expect(upgraded.classifications.every((row) => row.reviewState !== 'human_reviewed')).toBe(
      true
    );
    const roundTrip = parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(upgraded).bytes));
    expect(roundTrip.historicalAttestation).toEqual(upgraded.historicalAttestation);
    expect(roundTrip.attestation).toBeUndefined();
    const mismatched = structuredClone(legacy);
    mismatched.attestation = {
      ...(legacy.attestation as Record<string, unknown>),
      reviewContentHash: '0'.repeat(64),
    };
    expect(() => parseLicenseArtifact(mismatched)).toThrow(
      'Legacy v2 attestation is bound to another revision'
    );
    expect((await readFile(LICENSE_CLASSIFICATIONS_PATH)).equals(before)).toBe(true);
  }, 20000);

  it('rejects a v2 owned-content edit before assigning a v3 hash', async () => {
    const legacy = JSON.parse(await readFile(LICENSE_CLASSIFICATIONS_PATH, 'utf8')) as {
      classifications: Array<{ rationale: string }>;
    };
    legacy.classifications[0].rationale = 'Tampered legacy rationale';
    expect(() => parseLicenseArtifact(legacy)).toThrow('Legacy v2 review content hash mismatch');
  }, 20000);
});
