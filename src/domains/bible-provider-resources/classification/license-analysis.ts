import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { createLicenseClassifier } from '../license-classifier';
import type { StoredLicenseClassification } from './license-database.types';

import { checkLicenseArtifactReview, createLicenseArtifact } from '../license-artifact';
import { licenseClassificationSchema } from '../license-artifact.schemas';
import {
  LICENSE_CLASSIFICATION_PROMPT,
  LICENSE_CLASSIFICATION_PROMPT_HASH,
  LICENSE_INFERENCE_SETTINGS,
  LICENSE_VOTE_JSON_SCHEMA,
} from '../license-model-contract';
import { normalizeLicenseNotice } from '../license-normalizer';
import { LICENSE_RULE_SET_HASH } from '../license-rules';

/** Refresh owned database authority; only unconsumed JSON extensions overlay that source. */
export async function analyzeDatabaseLicenses(input: {
  catalog: LicenseArtifact['catalog'];
  classifications: StoredLicenseClassification[];
  base?: LicenseArtifact;
  classify: ReturnType<typeof createLicenseClassifier>;
  model: string;
  sampleCount: number;
  /** Checked between distinct keys, after all samples for the current key settle. */
  shouldStop?: () => boolean;
}) {
  const known = new Map(input.classifications.map((row) => [row.normalizedText, row]));
  const examples = new Map<string, string>();
  for (const row of input.catalog) {
    if (row.rawNotice?.trim()) {
      const key = normalizeLicenseNotice(row.rawNotice);
      if (!examples.has(key)) examples.set(key, row.rawNotice);
    }
  }
  // Retain authoritative keys even if the current catalog no longer contains them.
  for (const row of input.classifications)
    if (!examples.has(row.normalizedText)) examples.set(row.normalizedText, row.normalizedText);
  const classifications: LicenseClassification[] = [];
  // Serial distinct-key inference bounds model pressure; each key's independent samples run concurrently.
  for (const [normalizedText, exampleNotice] of [...examples].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (input.shouldStop?.()) throw new LicenseAnalysisStoppedError();
    const basePrior = input.base?.classifications.find(
      (row) => row.normalizedText === normalizedText
    );
    const storedEvidence = known.get(normalizedText)?.evidence;
    const prior = storedEvidence ?? basePrior;
    const stored = known.get(normalizedText);
    if (stored) {
      // The database is the source of owned provenance. Missing evidence is absent,
      // even when an older JSON decision/producer happens to match the same core fields.
      const hasCurrentEvidence =
        storedEvidence &&
        storedEvidence.status === stored.status &&
        storedEvidence.rationale === stored.rationale &&
        storedEvidence.normalizedText === normalizedText;
      const retained: LicenseClassification = hasCurrentEvidence
        ? structuredClone(storedEvidence)
        : {
            normalizedText,
            exampleNotice,
            status: stored.status,
            source: 'table',
            rationale: stored.rationale,
            samples: [],
          };
      if (basePrior) {
        for (const [key, value] of Object.entries(basePrior))
          if (!Object.hasOwn(licenseClassificationSchema.shape, key))
            Object.defineProperty(retained, key, {
              value: structuredClone(value),
              enumerable: true,
              configurable: true,
              writable: true,
            });
      }
      if ((retained.samples.length || retained.rule) && !retained.evidenceContract)
        retained.evidenceContract = stored.classificationRun;
      classifications.push(retained);
      continue;
    }
    const proposal = await input.classify(exampleNotice);
    classifications.push({
      ...(prior ? structuredClone(prior) : {}),
      normalizedText,
      exampleNotice,
      status: proposal.decision,
      source: proposal.source,
      rationale: proposal.rationale,
      samples: proposal.samples,
      ...('rule' in proposal ? { rule: proposal.rule } : {}),
    });
    const fresh = classifications.at(-1)!;
    delete fresh.rowNote;
    delete fresh.automaticDecision;
    delete fresh.evidenceContract;
    if (!('rule' in proposal)) delete fresh.rule;
  }
  const classificationRun: LicenseArtifact['classificationRun'] = {
    prompt: LICENSE_CLASSIFICATION_PROMPT,
    promptHash: LICENSE_CLASSIFICATION_PROMPT_HASH,
    ruleSetHash: LICENSE_RULE_SET_HASH,
    responseSchema: LICENSE_VOTE_JSON_SCHEMA,
    models: [
      {
        provider: 'google',
        model: input.model.replace(/^google:/, ''),
        sampleCount: input.sampleCount,
        settings: LICENSE_INFERENCE_SETTINGS,
      },
    ],
  };
  // Assemble authoritative rows directly. Generic edit cleanup compares against the
  // old JSON and must not revoke or erase notes that already belong to current DB evidence.
  const artifact = createLicenseArtifact({
    ...input.base,
    catalog: input.catalog,
    classifications,
    classificationRun,
  });
  if (input.base?.reviewContentHash === artifact.reviewContentHash && input.base.attestation) {
    artifact.attestation = structuredClone(input.base.attestation);
    if (!input.base.reviewState) delete artifact.reviewState;
    const checked = checkLicenseArtifactReview(artifact);
    if (checked.status === 'invalid') throw new Error(checked.reason);
    return checked.artifact;
  }
  return artifact;
}

export class LicenseAnalysisStoppedError extends Error {
  constructor() {
    super('Analysis stopped between distinct license keys; no result was published');
    this.name = 'LicenseAnalysisStoppedError';
  }
}
