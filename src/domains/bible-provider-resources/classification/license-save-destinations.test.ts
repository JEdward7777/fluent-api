import { describe, expect, it } from 'vitest';

import type { StoredLicenseClassification } from './license-database.types';

import {
  attestLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { makeLicenseArtifact, REVIEWER } from '../license-artifact.test-fixtures';
import { planLicenseSaveDestinations } from './license-save-destinations';

const time = '2026-11-17T12:00:00.000Z';
const base = () => makeLicenseArtifact();
const human = (artifact: ReturnType<typeof base>, index: number) =>
  recordHumanLicenseDecision(
    artifact,
    artifact.classifications[index].normalizedText,
    artifact.classifications[index].status,
    'A named decision',
    'Reviewer',
    time
  );
const stored = (artifact: ReturnType<typeof base>) =>
  artifact.classifications.map((row) => ({
    normalizedText: row.normalizedText,
    status: row.status,
    rationale: row.rationale,
    classifiedBy: row.source,
    reviewedAt: null,
    reviewState: row.reviewState,
    decisionAt: row.decisionAt,
    reviewedBy: row.reviewedBy,
    humanReviewedAt: row.humanReviewedAt,
    evidence: row,
    classificationRun: artifact.classificationRun,
  }));

describe('six independent license save destinations', () => {
  it('for JSON → JSON overwrites its captured artifact', () => {
    const source = base();
    const result = planLicenseSaveDestinations({
      source: 'json',
      destination: 'json',
      artifact: source,
      outputBytes: null,
    });
    expect(result.jsonArtifact).toBe(source);
    expect(result.databaseArtifact).toBeUndefined();
  });

  it('for JSON → DB preserves a human DB winner and omitted DB keys', () => {
    const source = base();
    const destination = human(base(), 1);
    const rows: StoredLicenseClassification[] = stored(destination);
    rows.push({ ...rows[0], normalizedText: 'omitted database key', evidence: undefined });
    const result = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact: source,
      outputBytes: null,
      databaseRows: rows,
    });
    expect(result.databaseChanges.preserved).toContain(source.classifications[1].normalizedText);
    expect(result.databaseChanges.preserved).toContain('omitted database key');
    expect(result.databaseArtifact?.classifications).toHaveLength(0);
    expect(result.databaseForecast?.classifications).toHaveLength(4);
  });

  it('for JSON → both keeps source model evidence in JSON while DB preserves human decision', () => {
    const source = base();
    const destination = human(base(), 1);
    const result = planLicenseSaveDestinations({
      source: 'json',
      destination: 'both',
      artifact: source,
      outputBytes: null,
      databaseRows: stored(destination),
    });
    expect(result.jsonArtifact?.classifications[1].reviewState).toBe('llm_reviewed');
    expect(result.databaseForecast?.classifications[1].reviewState).toBe('human_reviewed');
  });

  it('for DB → JSON preserves a stronger JSON row, its catalog, and prior evidence contract', () => {
    const source = base();
    const destination = human(base(), 1);
    const extra = {
      ...destination.classifications[2],
      normalizedText: 'destination only',
      exampleNotice: 'destination only',
    };
    destination.classifications.push(extra);
    destination.catalog.push({
      provider: 'dbl',
      externalId: 'extra',
      bibleId: 99,
      name: 'Extra',
      abbreviation: 'X',
      rawNotice: 'destination only',
    });
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(destination).bytes,
    });
    expect(result.conflicts).toEqual([]);
    expect(
      result.jsonArtifact?.classifications.find(
        (row) => row.normalizedText === source.classifications[1].normalizedText
      )?.reviewState
    ).toBe('human_reviewed');
    expect(
      result.jsonArtifact?.classifications.find((row) => row.normalizedText === 'destination only')
    ).toBeDefined();
    expect(result.jsonArtifact?.catalog.find((row) => row.externalId === 'extra')).toBeDefined();
    expect(result.databaseArtifact).toBeUndefined();
  });

  it('for DB → DB overwrites a local human draft with a model decision and retains omissions', () => {
    const source = base();
    const destination = human(base(), 1);
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'database',
      artifact: source,
      outputBytes: null,
      databaseRows: stored(destination),
    });
    expect(result.databaseArtifact?.classifications[1].reviewState).toBe('llm_reviewed');
    expect(result.databaseChanges.updated).toContain(source.classifications[1].normalizedText);
  });

  it('for DB → both never feeds a JSON human winner into the DB overwrite', () => {
    const source = base();
    const destination = human(base(), 1);
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'both',
      artifact: source,
      outputBytes: serializeLicenseArtifact(destination).bytes,
      databaseRows: stored(source),
    });
    expect(result.jsonArtifact?.classifications[1].reviewState).toBe('human_reviewed');
    expect(result.databaseArtifact?.classifications[1].reviewState).toBe('llm_reviewed');
  });

  it('blocks an equal-rank undated disagreement at its destination', () => {
    const source = base();
    const destination = base();
    destination.classifications[2].rationale = 'Different';
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(destination).bytes,
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.jsonArtifact).toBeUndefined();
  });

  it('retains a validated whole-artifact attestation when owned content is unchanged', () => {
    const original = attestLicenseArtifact(base(), REVIEWER);
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: original,
      outputBytes: serializeLicenseArtifact(original).bytes,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.jsonArtifact?.reviewContentHash).toBe(original.reviewContentHash);
    expect(result.jsonArtifact?.attestation).toEqual(original.attestation);
  });

  it('clears a prior whole-artifact attestation after a source catalog change', () => {
    const source = base();
    source.catalog[0].name = 'New DB name';
    const prior = base();
    prior.catalog.push({
      provider: 'dbl',
      externalId: 'extra',
      bibleId: 99,
      name: 'Extra',
      abbreviation: 'X',
      rawNotice: null,
    });
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(attestLicenseArtifact(prior, REVIEWER)).bytes,
    });
    expect(result.jsonArtifact?.attestation).toBeUndefined();
    expect(result.jsonArtifact?.catalog.find((row) => row.externalId === 'extra')).toBeDefined();
  });

  it('reports a catalog Bible ID collision at the JSON destination', () => {
    const source = base();
    source.catalog[0].bibleId = 99;
    const prior = base();
    prior.catalog.push({
      provider: 'dbl',
      externalId: 'extra',
      bibleId: 99,
      name: 'Extra',
      abbreviation: 'X',
      rawNotice: null,
    });
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(prior).bytes,
    });
    expect(result.conflicts.join(' ')).toContain('Bible ID');
    expect(result.jsonArtifact).toBeUndefined();
  });

  it('takes DB catalog fields for the same provider identity during JSON sync', () => {
    const source = base();
    source.catalog[0].name = 'Current DB title';
    const prior = base();
    prior.catalog[0].name = 'Old JSON title';
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(prior).bytes,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.jsonArtifact?.catalog[0].name).toBe('Current DB title');
  });

  it('previews the DB leg independently when the JSON leg has an unresolved conflict', () => {
    const source = base();
    const prior = base();
    prior.classifications[2].rationale = 'Different undated rationale';
    const result = planLicenseSaveDestinations({
      source: 'database',
      destination: 'both',
      artifact: source,
      outputBytes: serializeLicenseArtifact(prior).bytes,
      databaseRows: [],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.jsonArtifact).toBeUndefined();
    expect(result.databaseArtifact?.classifications).toHaveLength(3);
    expect(result.databaseChanges.inserted).toHaveLength(3);
  });
});
