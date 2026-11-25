import { describe, expect, it } from 'vitest';

import type { StoredLicenseClassification } from './license-database.types';

import legacy from '../__fixtures__/license-artifact-v3.json';
import {
  attestLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { parseLicenseArtifact } from '../license-artifact.schemas';
import { makeLicenseArtifact, REVIEWER } from '../license-artifact.test-fixtures';
import { planLicenseSaveDestinations } from './license-save-destinations';
import { licenseDecisionProducer } from './license-stored-decision';

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
    classifiedBy: licenseDecisionProducer(row, artifact.classificationRun),
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
      overwriteJson: true,
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
      overwriteJson: true,
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
      overwriteDatabase: true,
      destination: 'database',
      artifact: source,
      outputBytes: null,
      databaseRows: stored(destination),
    });
    expect(result.databaseArtifact?.classifications.map((row) => row.reviewState)).toEqual([
      'llm_reviewed',
    ]);
    expect(result.databaseChanges.updated).toContain(source.classifications[1].normalizedText);
  });

  it('for DB → both never feeds a JSON human winner into the DB overwrite', () => {
    const source = base();
    const destination = human(base(), 1);
    const result = planLicenseSaveDestinations({
      overwriteDatabase: true,
      destination: 'both',
      artifact: source,
      outputBytes: serializeLicenseArtifact(destination).bytes,
      databaseRows: stored(source),
    });
    expect(result.jsonArtifact?.classifications[1].reviewState).toBe('human_reviewed');
    expect(result.databaseArtifact?.classifications).toEqual([]);
  });

  it.each([
    { overwriteJson: true, overwriteDatabase: false },
    { overwriteJson: false, overwriteDatabase: true },
    { overwriteJson: false, overwriteDatabase: false },
  ])('plans Both independently for %j', (modes) => {
    const candidate = base();
    const file = human(base(), 1);
    const database = human(base(), 0);
    const result = planLicenseSaveDestinations({
      ...modes,
      destination: 'both',
      artifact: candidate,
      outputBytes: serializeLicenseArtifact(file).bytes,
      databaseRows: stored(database),
    });
    expect(result.conflicts).toEqual([]);
    const fileKey = candidate.classifications[1].normalizedText;
    const databaseKey = candidate.classifications[0].normalizedText;
    expect(result.jsonChanges[modes.overwriteJson ? 'metadataChanges' : 'preserved']).toEqual([
      fileKey,
    ]);
    expect(
      result.databaseChanges[modes.overwriteDatabase ? 'metadataChanges' : 'preserved']
    ).toEqual([databaseKey]);
    expect(result.databaseArtifact?.classifications.map((row) => row.normalizedText)).toEqual(
      modes.overwriteDatabase ? [databaseKey] : []
    );
    expect(result.jsonChanges.unchanged).toHaveLength(2);
    expect(result.databaseChanges.unchanged).toHaveLength(2);
  });

  it('counts one metadata edit separately from hundreds of unchanged JSON records', () => {
    const prior = base();
    for (let index = 0; index < 500; index++) {
      const text = `license policy ${index}`;
      prior.classifications.push({
        ...prior.classifications[2],
        normalizedText: text,
        exampleNotice: text,
      });
    }
    const candidate = human(prior, 1);
    const result = planLicenseSaveDestinations({
      destination: 'json',
      overwriteJson: true,
      artifact: candidate,
      outputBytes: serializeLicenseArtifact(prior).bytes,
    });
    expect(result.jsonChanges.metadataChanges).toEqual([prior.classifications[1].normalizedText]);
    expect(result.jsonChanges.updated).toEqual(result.jsonChanges.metadataChanges);
    expect(result.jsonChanges.unchanged).toHaveLength(502);
    expect(result.jsonArtifact?.classifications).toHaveLength(503);
  });

  it('blocks an equal-rank undated disagreement at its destination', () => {
    const source = base();
    const destination = base();
    destination.classifications[2].rationale = 'Different';
    const result = planLicenseSaveDestinations({
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(destination).bytes,
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.jsonArtifact).toBeUndefined();
  });

  it('preserves the signed destination winner with a genuinely unavailable original notice', () => {
    const source = base();
    const destination = base();
    const row = destination.classifications[2];
    Object.assign(row, {
      source: 'table',
      exampleNotice: null,
      reviewState: 'human_reviewed',
      decisionAt: time,
      reviewedBy: 'Table reviewer',
      humanReviewedAt: time,
    });
    const signed = attestLicenseArtifact(destination, REVIEWER);
    const plan = planLicenseSaveDestinations({
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(signed).bytes,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.jsonChanges.preserved).toEqual([row.normalizedText]);
    expect(plan.jsonChanges.updated).toEqual([]);
    expect(
      plan.jsonArtifact?.classifications.find(
        (entry) => entry.normalizedText === row.normalizedText
      )
    ).toEqual(row);
    expect(plan.jsonArtifact?.reviewContentHash).toBe(signed.reviewContentHash);
    expect(plan.jsonArtifact?.attestation).toEqual(signed.attestation);
  });

  it.each(['missing', 'weaker'] as const)(
    'preserves signed source notices in Both targets when the JSON target is %s',
    (target) => {
      const weaker = base();
      const candidate = human(base(), 2);
      const winner = candidate.classifications[2];
      winner.exampleNotice = null;
      const signed = attestLicenseArtifact(candidate, REVIEWER);
      const first = planLicenseSaveDestinations({
        destination: 'both',
        artifact: signed,
        outputBytes: target === 'missing' ? null : serializeLicenseArtifact(weaker).bytes,
        databaseRows: stored(weaker),
      });
      expect(first.conflicts).toEqual([]);
      expect(first.jsonChanges[target === 'missing' ? 'inserted' : 'updated']).toContain(
        winner.normalizedText
      );
      expect(
        first.jsonArtifact?.classifications.find(
          (row) => row.normalizedText === winner.normalizedText
        )
      ).toEqual(winner);
      expect(first.jsonArtifact?.attestation).toEqual(signed.attestation);
      expect(first.databaseArtifact?.classifications).toEqual([winner]);
      const repeat = planLicenseSaveDestinations({
        destination: 'both',
        artifact: signed,
        outputBytes: serializeLicenseArtifact(first.jsonArtifact!).bytes,
        databaseRows: stored(signed),
      });
      expect(repeat.conflicts).toEqual([]);
      expect(repeat.jsonChanges.unchanged).toHaveLength(3);
      expect(repeat.databaseChanges.unchanged).toHaveLength(3);
      expect(repeat.databaseArtifact?.classifications).toEqual([]);
      expect(repeat.jsonArtifact?.attestation).toEqual(signed.attestation);
    }
  );

  it.each([false, true])(
    'distinguishes a missing catalog association from an empty normalized key (reverse %s)',
    (reverse) => {
      const associated = base();
      const unassociated = base();
      const rawNotice = 'Copyright 2024';
      const extra = {
        ...associated.classifications[2],
        normalizedText: '',
        exampleNotice: rawNotice,
      };
      associated.classifications.push(extra);
      associated.catalog[0].rawNotice = rawNotice;
      unassociated.catalog[0].rawNotice = null;
      const [candidate, prior] = reverse ? [unassociated, associated] : [associated, unassociated];
      const result = planLicenseSaveDestinations({
        destination: 'both',
        artifact: candidate,
        outputBytes: serializeLicenseArtifact(prior).bytes,
        databaseRows: [],
      });
      expect(result.conflicts.join(' ')).toContain('Conflicting notice associations');
      expect(result.jsonArtifact).toBeUndefined();
    }
  );

  it('preserves migrated assertions and both artifacts’ independent extensions across repeat sync', () => {
    const prior = parseLicenseArtifact(legacy);
    const source = structuredClone(prior);
    delete source.historicalAttestations;
    delete source.migrationExtensions;
    source.sourceOnly = { local: 'A' };
    const input = { ...legacy, destinationOnly: ['B'] };
    const merge = (outputBytes: string) =>
      planLicenseSaveDestinations({ destination: 'json', artifact: source, outputBytes });
    const first = merge(JSON.stringify(input));
    expect(first.conflicts).toEqual([]);
    const merged = first.jsonArtifact!;
    expect(merged.historicalAttestations).toEqual(prior.historicalAttestations);
    expect(merged.migrationExtensions).toEqual(prior.migrationExtensions);
    expect(merged.destinationOnly).toEqual(['B']);
    expect(merged.sourceOnly).toEqual(source.sourceOnly);
    expect(merged.attestation).toBeUndefined();
    source.historicalAttestations = prior.historicalAttestations;
    expect(
      merge(serializeLicenseArtifact(merged).bytes).jsonArtifact?.historicalAttestations
    ).toEqual(prior.historicalAttestations);
    source.destinationOnly = ['different'];
    expect(merge(serializeLicenseArtifact(merged).bytes).conflicts.join(' ')).toContain(
      'Conflicting artifact extension destinationOnly'
    );
  });

  it('retains a validated whole-artifact attestation when owned content is unchanged', () => {
    const original = attestLicenseArtifact(base(), REVIEWER);
    const result = planLicenseSaveDestinations({
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
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(attestLicenseArtifact(prior, REVIEWER)).bytes,
    });
    expect(result.jsonArtifact?.attestation).toBeUndefined();
    expect(result.jsonArtifact?.catalog.find((row) => row.externalId === 'extra')).toBeDefined();
  });

  it('blocks a sync that would replace a catalog association with another valid notice', () => {
    const source = base();
    const prior = base();
    prior.catalog[0].rawNotice = prior.classifications[1].exampleNotice;
    const plan = planLicenseSaveDestinations({
      destination: 'json',
      artifact: source,
      outputBytes: serializeLicenseArtifact(prior).bytes,
    });
    expect(plan.conflicts.join(' ')).toContain('Conflicting notice associations');
    expect(plan.jsonArtifact).toBeUndefined();
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
      overwriteDatabase: true,
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
