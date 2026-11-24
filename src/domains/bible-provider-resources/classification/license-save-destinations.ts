import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';

import { checkLicenseArtifactReview, createLicenseArtifact } from '../license-artifact';
import { computeLicenseReviewHash } from '../license-artifact.hash';
import {
  indexLicenseNoticeExamples,
  isLicenseNoticeUnavailable,
  savedLicenseNotices,
} from '../license-normalizer';
import { planLicenseDatabaseChanges } from './license-database-projection';
import { planLicenseDecisionMerge } from './license-decision-merge';
import { storedLicenseDecision } from './license-stored-decision';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';

function withNotice(row: LicenseClassification, examples: Map<string, string>) {
  const raw = examples.get(row.normalizedText);
  return isLicenseNoticeUnavailable(row.exampleNotice) && raw !== undefined
    ? { ...row, exampleNotice: raw }
    : row;
}

function withContract(row: LicenseClassification, run: LicenseArtifact['classificationRun']) {
  const copy = structuredClone(row);
  if ((copy.samples.length || copy.rule) && !copy.evidenceContract)
    copy.evidenceContract = structuredClone(run);
  return copy;
}

function sameRun(
  left: LicenseArtifact['classificationRun'],
  right: LicenseArtifact['classificationRun']
) {
  const owned = (run: LicenseArtifact['classificationRun']) =>
    JSON.stringify({
      prompt: run.prompt,
      promptHash: run.promptHash,
      ruleSetHash: run.ruleSetHash,
      responseSchema: run.responseSchema,
      models: run.models.map((model) => ({
        provider: model.provider,
        model: model.model,
        sampleCount: model.sampleCount,
        settings: model.settings,
      })),
    });
  return owned(left) === owned(right);
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
  jsonChanges: { inserted: string[]; updated: string[]; preserved: string[]; unchanged: string[] };
  databaseChanges: {
    inserted: string[];
    updated: string[];
    preserved: string[];
    unchanged: string[];
  };
  conflicts: string[];
}

const emptyChanges = () => ({
  inserted: [] as string[],
  updated: [] as string[],
  preserved: [] as string[],
  unchanged: [] as string[],
});

/** Plans each destination independently. No destination winner enters a source overwrite. */
export function planLicenseSaveDestinations(input: {
  source: 'json' | 'database';
  destination: 'json' | 'database' | 'both';
  artifact: LicenseArtifact;
  outputBytes: string | null;
  databaseRows?: StoredLicenseClassification[];
  overwriteJson?: boolean;
  overwriteDatabase?: boolean;
}): DestinationDecisionPlan {
  const { source, destination, artifact } = input;
  const result: DestinationDecisionPlan = {
    jsonChanges: emptyChanges(),
    databaseChanges: emptyChanges(),
    conflicts: [],
  };
  if (destination !== 'database') {
    if (input.overwriteJson ?? source === 'json') {
      result.jsonArtifact = artifact;
      result.jsonChanges.updated = artifact.classifications.map((row) => row.normalizedText);
    } else {
      const prior =
        input.outputBytes === null ? null : parseLicenseArtifactBytes(input.outputBytes);
      const examples = indexLicenseNoticeExamples([
        ...savedLicenseNotices(artifact),
        ...savedLicenseNotices(prior ?? undefined),
      ]);
      const sourceRows = artifact.classifications.map((row) => withNotice(row, examples));
      const destinationRows = (prior?.classifications ?? []).map((row) =>
        withNotice(row, examples)
      );
      const decisions = planLicenseDecisionMerge(
        sourceRows.map((row) => withContract(row, artifact.classificationRun)),
        destinationRows.map((row) => withContract(row, prior!.classificationRun))
      );
      for (const decision of decisions) {
        const changes = result.jsonChanges;
        if (decision.reason === 'conflict')
          result.conflicts.push(
            `JSON classification ${decision.normalizedText}: equal-rank decision ordering is unresolved`
          );
        else if (decision.reason === 'insert') changes.inserted.push(decision.normalizedText);
        else if (decision.reason === 'update') changes.updated.push(decision.normalizedText);
        else if (decision.reason === 'preserve') changes.preserved.push(decision.normalizedText);
        else changes.unchanged.push(decision.normalizedText);
      }
      if (!result.conflicts.length) {
        const catalog = new Map(
          (prior?.catalog ?? []).map((row) => [JSON.stringify([row.provider, row.externalId]), row])
        );
        for (const row of artifact.catalog)
          catalog.set(JSON.stringify([row.provider, row.externalId]), row);
        try {
          const merged = artifactWithRows(
            artifact,
            decisions.map((decision) => {
              const original =
                decision.reason === 'insert' || decision.reason === 'update'
                  ? sourceRows.find((row) => row.normalizedText === decision.normalizedText)!
                  : destinationRows.find((row) => row.normalizedText === decision.normalizedText)!;
              return decision.reason === 'preserve' || decision.reason === 'no-op'
                ? prior && !sameRun(prior.classificationRun, artifact.classificationRun)
                  ? withContract(original, prior.classificationRun)
                  : original
                : original;
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
            `JSON catalog: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  if (destination !== 'json') {
    const overwrite = input.overwriteDatabase ?? source === 'database';
    const examples = indexLicenseNoticeExamples([
      ...savedLicenseNotices(artifact),
      ...(input.databaseRows ?? []).map((row) => row.exampleNotice ?? null),
    ]);
    const destinationRows = (input.databaseRows ?? []).map((row) =>
      storedLicenseDecision(row, examples.get(row.normalizedText))
    );
    const comparisonExamples = indexLicenseNoticeExamples(
      destinationRows.map((row) => row.exampleNotice)
    );
    const decisions = overwrite
      ? artifact.classifications.map((row) => ({
          normalizedText: row.normalizedText,
          source: row,
          destination:
            destinationRows.find((prior) => prior.normalizedText === row.normalizedText) ?? null,
          winner: row,
          reason: 'update' as const,
        }))
      : planLicenseDecisionMerge(
          artifact.classifications.map((row) =>
            withContract(withNotice(row, comparisonExamples), artifact.classificationRun)
          ),
          destinationRows
        );
    const overwriteDiff = overwrite
      ? planLicenseDatabaseChanges(artifact, input.databaseRows ?? [])
      : null;
    for (const decision of decisions) {
      const changes = result.databaseChanges;
      if (decision.reason === 'conflict')
        result.conflicts.push(
          `Database classification ${decision.normalizedText}: equal-rank decision ordering is unresolved`
        );
      else if (decision.reason === 'insert') changes.inserted.push(decision.normalizedText);
      else if (overwriteDiff) {
        if (overwriteDiff.insertedKeys.includes(decision.normalizedText))
          changes.inserted.push(decision.normalizedText);
        else if (overwriteDiff.changedKeys.includes(decision.normalizedText))
          changes.updated.push(decision.normalizedText);
        else changes.unchanged.push(decision.normalizedText);
      } else if (decision.reason === 'update') changes.updated.push(decision.normalizedText);
      else if (decision.reason === 'preserve') changes.preserved.push(decision.normalizedText);
      else changes.unchanged.push(decision.normalizedText);
    }
    if (!decisions.some((decision) => decision.reason === 'conflict')) {
      const writes = decisions
        .filter(
          (decision) =>
            decision.source && (decision.reason === 'insert' || decision.reason === 'update')
        )
        .map((decision) => decision.winner!);
      result.databaseArtifact = { ...artifact, classifications: writes };
      const forecast = new Map(destinationRows.map((row) => [row.normalizedText, row]));
      for (const row of writes) forecast.set(row.normalizedText, row);
      result.databaseForecast = { ...artifact, classifications: [...forecast.values()] };
      result.databaseForecast.reviewContentHash = computeLicenseReviewHash(result.databaseForecast);
    }
  }
  return result;
}
