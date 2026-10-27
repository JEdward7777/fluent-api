import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';

import type { StoredLicenseClassification } from './classification/license-database.types';
import type { LicenseArtifact } from './license-artifact.schemas';

import { planLicenseDatabaseChanges } from './classification/license-database-projection';
import { normalizeLicenseNotice } from './license-normalizer';

export interface DatabaseLicenseResource {
  provider: LicenseArtifact['catalog'][number]['provider'];
  externalId: string;
  bibleId: number | null;
  name: string;
  abbreviation: string;
  rawNotice: string | null;
  ttsLicenseStatus: TtsLicenseStatus;
}
export interface LicenseDatabaseContext {
  label: string;
  resources: DatabaseLicenseResource[];
  /** Classification import forecasts current target rows, never catalog acquisition writes. */
  projection?: 'classification-only';
  classificationTable?: { existing: StoredLicenseClassification[]; replace: boolean };
}

/** Invocation-scoped preservation never changes the authoritative derived decision. */
export function effectiveLicenseStatus(
  rawNotice: string | null,
  classifications: ReadonlyMap<string, TtsLicenseStatus>,
  current?: TtsLicenseStatus,
  preserveExistingNonUnknowns = false
) {
  const empty = rawNotice === null || rawNotice.trim() === '';
  const normalizedText = empty ? null : normalizeLicenseNotice(rawNotice);
  const classified = normalizedText === null ? undefined : classifications.get(normalizedText);
  const derivedStatus: TtsLicenseStatus = empty ? 'forbidden' : (classified ?? 'unknown');
  const preserve = preserveExistingNonUnknowns && current !== undefined && current !== 'unknown';
  const status = preserve ? current : derivedStatus;
  return {
    normalizedText,
    derivedStatus,
    status,
    missingClassification: !empty && classified === undefined,
    disagreement: status !== derivedStatus,
  };
}

const identity = (provider: string, externalId: string) => JSON.stringify([provider, externalId]);

export function computeLicenseImpact(
  artifact: LicenseArtifact,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false
) {
  const statuses = new Map(artifact.classifications.map((row) => [row.normalizedText, row.status]));
  const before = new Map<string, DatabaseLicenseResource>();
  for (const resource of database?.resources ?? []) {
    const key = identity(resource.provider, resource.externalId);
    if (before.has(key)) throw new Error('Duplicate database provider identity in impact context');
    before.set(key, resource);
  }
  const catalog = new Map(
    artifact.catalog.map((bible) => [identity(bible.provider, bible.externalId), bible])
  );
  // Retained database-only resources also derive policy; a JSON source cannot hide their effects.
  const targetOnly = database?.projection === 'classification-only';
  const keys = new Set(targetOnly ? before.keys() : [...catalog.keys(), ...before.keys()]);
  const rows = [...keys].sort().map((key) => {
    const current = before.get(key) ?? null;
    const snapshot = catalog.get(key);
    const bible = targetOnly ? current! : (snapshot ?? current!);
    const effective = effectiveLicenseStatus(
      bible.rawNotice,
      statuses,
      current?.ttsLicenseStatus,
      preserveExistingNonUnknowns
    );
    return {
      key,
      provider: bible.provider,
      externalId: bible.externalId,
      bibleId: current ? current.bibleId : bible.bibleId,
      name: current ? current.name : bible.name,
      abbreviation: current ? current.abbreviation : bible.abbreviation,
      rawNotice: bible.rawNotice,
      currentStatus: current?.ttsLicenseStatus ?? null,
      currentNotice: current?.rawNotice ?? null,
      snapshotNotice: snapshot?.rawNotice ?? null,
      ...effective,
      isNew: database ? current === null : null,
      statusChanged: database
        ? current === null || current.ttsLicenseStatus !== effective.status
        : null,
      noticeChanged: database
        ? current !== null && snapshot !== undefined && current.rawNotice !== snapshot.rawNotice
        : null,
    };
  });
  const totals = { allowed: 0, forbidden: 0, unknown: 0 };
  for (const row of rows) totals[row.status]++;
  const classificationTotals = { allowed: 0, forbidden: 0, unknown: 0 };
  for (const row of artifact.classifications) classificationTotals[row.status]++;
  const rawByNormalized = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.normalizedText === null || row.rawNotice === null) continue;
    const raw = rawByNormalized.get(row.normalizedText) ?? new Set<string>();
    raw.add(row.rawNotice);
    rawByNormalized.set(row.normalizedText, raw);
  }
  const collisions = [...rawByNormalized]
    .filter(([, notices]) => notices.size > 1)
    .map(([normalizedText, notices]) => ({ normalizedText, notices: [...notices].sort() }))
    .sort((a, b) =>
      a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0
    );
  const samples = artifact.classifications.flatMap((row) => row.samples);
  return {
    context: database
      ? {
          kind: 'database' as const,
          classificationOnly: targetOnly,
          label: database.label,
          disclaimer: `Impact compares the exact supplied database rows: ${database.label}. No production state is inferred.${targetOnly ? ' Classification-only import changes no Bible metadata or notices; projected statuses use current target notices after the following ordinary sync. Notice changes below indicate artifact snapshot drift only.' : ''}`,
        }
      : {
          kind: 'artifact-only' as const,
          label: null,
          disclaimer:
            'Production impact is unavailable because no database context was supplied. This is an artifact-only report.',
        },
    classificationChanges: database?.classificationTable?.replace
      ? planLicenseDatabaseChanges(artifact, database.classificationTable.existing)
      : null,
    preserveExistingNonUnknowns,
    preservationWarning: preserveExistingNonUnknowns
      ? 'Preservation applies to this invocation only. It may retain stale status drift; every disagreement is listed. A later ordinary sync derives status again.'
      : null,
    rows,
    totals,
    classificationTotals,
    changes: rows.filter((row) => row.statusChanged),
    newCatalogRows: rows.filter((row) => row.isNew),
    noticeChanges: rows.filter((row) => row.noticeChanged),
    disagreements: rows.filter((row) => row.disagreement),
    missingClassifications: rows.filter((row) => row.missingClassification),
    unknownClassifications: artifact.classifications
      .filter((row) => row.status === 'unknown')
      .map((row) => ({ normalizedText: row.normalizedText, rowNote: row.rowNote ?? null })),
    collisions,
    unchanged: database
      ? rows.filter((row) => row.statusChanged === false && !row.noticeChanged).length
      : null,
    ttsGains: database
      ? rows.filter((row) => row.currentStatus !== 'allowed' && row.status === 'allowed').length
      : null,
    ttsLosses: database
      ? rows.filter((row) => row.currentStatus === 'allowed' && row.status !== 'allowed').length
      : null,
    diagnostics: {
      cacheHits: samples.filter((sample) => sample.cacheHit === true).length,
      freshSamples: samples.filter((sample) => sample.cacheHit === false).length,
      newCalls: samples.reduce((sum, sample) => sum + (sample.attempts ?? 0), 0),
      unreportedSamples: samples.filter(
        (sample) => sample.cacheHit === undefined || sample.attempts === undefined
      ).length,
    },
  };
}
