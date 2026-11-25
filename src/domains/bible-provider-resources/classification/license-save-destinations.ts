import { isDeepStrictEqual } from 'node:util';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';

import { checkLicenseArtifactReview, createLicenseArtifact } from '../license-artifact';
import { computeLicenseReviewHash } from '../license-artifact.hash';
import { licenseArtifactSchema } from '../license-artifact.schemas';
import { normalizeLicenseNotice } from '../license-normalizer';
import { licenseRowRevision } from '../license-review-revision';
import { planLicenseDatabaseChanges } from './license-database-projection';
import { planLicenseDecisionMerge } from './license-decision-merge';
import { storedLicenseDecision } from './license-stored-decision';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';

function catalogNoticeKey(rawNotice: string | null) {
  return rawNotice?.trim() ? normalizeLicenseNotice(rawNotice) : null;
}

function withContract(row: LicenseClassification, run: LicenseArtifact['classificationRun']) {
  const copy = structuredClone(row);
  if ((copy.samples.length || copy.rule) && !copy.evidenceContract)
    copy.evidenceContract = structuredClone(run);
  return copy;
}

function mergedArtifactMetadata(source: LicenseArtifact, destination: LicenseArtifact | null) {
  const extensions = Object.entries(destination ?? {}).filter(
    ([key]) => !Object.hasOwn(licenseArtifactSchema.shape, key)
  );
  for (const [key, value] of extensions) {
    if (Object.hasOwn(source, key) && !isDeepStrictEqual(value, source[key]))
      throw new Error(`Conflicting artifact extension ${key}`);
  }
  const historicalAttestations = [...(destination?.historicalAttestations ?? [])];
  for (const assertion of source.historicalAttestations ?? []) {
    if (!historicalAttestations.some((prior) => isDeepStrictEqual(prior, assertion)))
      historicalAttestations.push(assertion);
  }
  return {
    ...Object.fromEntries(extensions),
    ...source,
    ...(historicalAttestations.length ? { historicalAttestations } : {}),
  };
}

function artifactWithRows(
  source: LicenseArtifact,
  rows: LicenseClassification[],
  catalog: LicenseArtifact['catalog']
): LicenseArtifact {
  const result = createLicenseArtifact({
    ...source,
    classifications: rows,
    catalog,
  });
  if (source.attestation && source.reviewContentHash === result.reviewContentHash) {
    result.attestation = structuredClone(source.attestation);
    if (!source.reviewState) delete result.reviewState;
    const checked = checkLicenseArtifactReview(result);
    if (checked.status === 'invalid') throw new Error(checked.reason);
  }
  return result;
}

export interface DestinationDecisionPlan {
  jsonArtifact?: LicenseArtifact;
  databaseArtifact?: LicenseArtifact;
  databaseForecast?: LicenseArtifact;
  jsonChanges: ReturnType<typeof emptyChanges> & {
    deleted: string[];
    deletedCatalog: Array<Pick<LicenseArtifact['catalog'][number], 'provider' | 'externalId'>>;
  };
  databaseChanges: ReturnType<typeof emptyChanges>;
  conflicts: string[];
}

const emptyChanges = () => ({
  inserted: [] as string[],
  updated: [] as string[],
  permissionChanges: [] as string[],
  metadataChanges: [] as string[],
  preserved: [] as string[],
  unchanged: [] as string[],
});

function recordUpdate(
  changes: ReturnType<typeof emptyChanges>,
  row: LicenseClassification,
  prior: LicenseClassification
) {
  changes.updated.push(row.normalizedText);
  (row.status === prior.status ? changes.metadataChanges : changes.permissionChanges).push(
    row.normalizedText
  );
}

function recordSync(
  changes: ReturnType<typeof emptyChanges>,
  decisions: ReturnType<typeof planLicenseDecisionMerge>,
  label: string,
  conflicts: string[]
) {
  for (const decision of decisions) {
    const key = decision.normalizedText;
    switch (decision.reason) {
      case 'conflict':
        conflicts.push(
          `${label} classification ${key}: equal-rank decision ordering is unresolved`
        );
        break;
      case 'insert':
        changes.inserted.push(key);
        break;
      case 'update':
        recordUpdate(changes, decision.source!, decision.destination!);
        break;
      case 'preserve':
        changes.preserved.push(key);
        break;
      case 'no-op':
        changes.unchanged.push(key);
        break;
    }
  }
}

/** Plans each destination independently. No destination winner enters a source overwrite. */
export function planLicenseSaveDestinations(input: {
  destination: 'json' | 'database' | 'both';
  artifact: LicenseArtifact;
  outputBytes: string | null;
  databaseRows?: StoredLicenseClassification[];
  overwriteJson?: boolean;
  overwriteDatabase?: boolean;
}): DestinationDecisionPlan {
  const { destination, artifact } = input;
  const result: DestinationDecisionPlan = {
    jsonChanges: { ...emptyChanges(), deleted: [], deletedCatalog: [] },
    databaseChanges: emptyChanges(),
    conflicts: [],
  };
  if (destination !== 'database') {
    const prior = input.outputBytes === null ? null : parseLicenseArtifactBytes(input.outputBytes);
    if (input.overwriteJson) {
      result.jsonArtifact = artifact;
      const priorByKey = new Map(prior?.classifications.map((row) => [row.normalizedText, row]));
      for (const row of artifact.classifications) {
        const before = priorByKey.get(row.normalizedText);
        if (!before) result.jsonChanges.inserted.push(row.normalizedText);
        else if (
          isDeepStrictEqual(
            licenseRowRevision(row, artifact.classificationRun),
            licenseRowRevision(before, prior!.classificationRun)
          )
        )
          result.jsonChanges.unchanged.push(row.normalizedText);
        else recordUpdate(result.jsonChanges, row, before);
        priorByKey.delete(row.normalizedText);
      }
      result.jsonChanges.deleted.push(...priorByKey.keys());
      const catalogKeys = new Set(
        artifact.catalog.map(({ provider, externalId }) => JSON.stringify([provider, externalId]))
      );
      result.jsonChanges.deletedCatalog = (prior?.catalog ?? [])
        .filter(
          ({ provider, externalId }) => !catalogKeys.has(JSON.stringify([provider, externalId]))
        )
        .map(({ provider, externalId }) => ({ provider, externalId }));
    } else {
      const sourceRows = artifact.classifications;
      const destinationRows = prior?.classifications ?? [];
      const sourceByKey = new Map(sourceRows.map((row) => [row.normalizedText, row]));
      const destinationByKey = new Map(destinationRows.map((row) => [row.normalizedText, row]));
      const decisions = planLicenseDecisionMerge(
        sourceRows.map((row) => withContract(row, artifact.classificationRun)),
        destinationRows.map((row) => withContract(row, prior!.classificationRun))
      );
      recordSync(result.jsonChanges, decisions, 'JSON', result.conflicts);
      if (!result.conflicts.length) {
        const distinctRun =
          prior && !isDeepStrictEqual(prior.classificationRun, artifact.classificationRun);
        const catalog = new Map(
          (prior?.catalog ?? []).map((row) => [JSON.stringify([row.provider, row.externalId]), row])
        );
        try {
          for (const row of artifact.catalog) {
            const identity = JSON.stringify([row.provider, row.externalId]);
            const existing = catalog.get(identity);
            if (
              existing &&
              catalogNoticeKey(existing.rawNotice) !== catalogNoticeKey(row.rawNotice)
            ) {
              throw new Error(
                `Conflicting notice associations for ${row.provider}/${row.externalId}`
              );
            }
            if (
              existing?.bibleId != null &&
              row.bibleId != null &&
              existing.bibleId !== row.bibleId
            )
              throw new Error(`Conflicting Bible IDs for ${row.provider}/${row.externalId}`);
            catalog.set(identity, {
              ...existing,
              ...row,
              bibleId: row.bibleId ?? existing?.bibleId ?? null,
            });
          }
          const merged = artifactWithRows(
            mergedArtifactMetadata(artifact, prior),
            decisions.map((decision) => {
              if (decision.reason === 'insert' || decision.reason === 'update')
                return sourceByKey.get(decision.normalizedText)!;
              const original = destinationByKey.get(decision.normalizedText)!;
              return distinctRun ? withContract(original, prior.classificationRun) : original;
            }),
            [...catalog.values()]
          );
          // A prior assertion binds only unchanged owned content.
          if (prior?.attestation && prior.reviewContentHash === merged.reviewContentHash) {
            merged.attestation = structuredClone(prior.attestation);
            if (!prior.reviewState) delete merged.reviewState;
          }
          merged.reviewContentHash = computeLicenseReviewHash(merged);
          result.jsonArtifact = merged;
        } catch (error) {
          result.conflicts.push(
            `JSON artifact or catalog: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  if (destination !== 'json') {
    const overwrite = input.overwriteDatabase;
    const destinationRows = (input.databaseRows ?? []).map((row) => storedLicenseDecision(row));
    const destinationByKey = new Map(destinationRows.map((row) => [row.normalizedText, row]));
    let writes: LicenseClassification[];
    const changes = result.databaseChanges;
    if (overwrite) {
      const diff = planLicenseDatabaseChanges(artifact, input.databaseRows ?? []);
      const changed = new Set(diff.changedKeys);
      const proposed = new Set(artifact.classifications.map((row) => row.normalizedText));
      changes.inserted.push(...diff.insertedKeys);
      changes.preserved.push(
        ...destinationRows
          .filter((row) => !proposed.has(row.normalizedText))
          .map((row) => row.normalizedText)
      );
      writes = artifact.classifications.filter((row) => {
        const before = destinationByKey.get(row.normalizedText);
        if (!before) return true;
        if (changed.has(row.normalizedText)) {
          recordUpdate(changes, row, before);
          return true;
        }
        changes.unchanged.push(row.normalizedText);
        return false;
      });
    } else {
      const decisions = planLicenseDecisionMerge(
        artifact.classifications.map((row) => withContract(row, artifact.classificationRun)),
        destinationRows
      );
      recordSync(changes, decisions, 'Database', result.conflicts);
      if (decisions.some((decision) => decision.reason === 'conflict')) return result;
      writes = decisions
        .filter((decision) => decision.reason === 'insert' || decision.reason === 'update')
        .map((decision) => decision.winner!);
    }
    result.databaseArtifact = { ...artifact, classifications: writes };
    const forecast = new Map(destinationRows.map((row) => [row.normalizedText, row]));
    for (const row of writes) forecast.set(row.normalizedText, row);
    result.databaseForecast = { ...artifact, classifications: [...forecast.values()] };
    result.databaseForecast.reviewContentHash = computeLicenseReviewHash(result.databaseForecast);
  }
  return result;
}
