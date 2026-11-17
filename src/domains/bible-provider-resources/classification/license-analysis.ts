import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { createLicenseClassifier } from '../license-classifier';
import type { StoredLicenseClassification } from './license-database.types';
import type { LicenseEligibilityRow } from './license-eligibility';

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
import { assessedLicenseRow } from './license-assessment';

/** Refresh owned database authority; only unconsumed JSON extensions overlay that source. */
export async function analyzeDatabaseLicenses(input: {
  catalog: LicenseArtifact['catalog'];
  classifications: StoredLicenseClassification[];
  base?: LicenseArtifact;
  classify: ReturnType<typeof createLicenseClassifier>;
  model: string;
  sampleCount: number;
  eligibility?: LicenseEligibilityRow[];
  now?: () => string;
  /** Checked between distinct keys, after all samples for the current key settle. */
  shouldStop?: () => boolean;
}) {
  const known = new Map(input.classifications.map((row) => [row.normalizedText, row]));
  const selected = new Map(input.eligibility?.map((row) => [row.normalizedText, row]));
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
    const stored = known.get(normalizedText);
    const action = selected.get(normalizedText)?.action ?? (stored ? 'retain' : 'rule');
    if (
      stored &&
      (action === 'retain' || (action === 'rule' && !selected.get(normalizedText)?.ruleMatches))
    ) {
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
    const proposal = await input.classify(
      exampleNotice,
      undefined,
      action === 'model' ? 'model-only' : 'rules-then-model'
    );
    // A prior JSON row may be a stronger destination winner, but it is never DB-source
    // decision authority. Carry only inert extensions into a newly assessed row.
    const fresh = assessedLicenseRow({
      normalizedText,
      exampleNotice,
      proposal,
      previous: storedEvidence,
      previousRun: stored?.classificationRun,
      classificationRun,
      now: input.now ?? (() => new Date().toISOString()),
    });
    if (basePrior) {
      for (const [key, value] of Object.entries(basePrior))
        if (!Object.hasOwn(licenseClassificationSchema.shape, key))
          Object.defineProperty(fresh, key, {
            value: structuredClone(value),
            enumerable: true,
            configurable: true,
            writable: true,
          });
    }
    classifications.push(fresh);
  }
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

/** JSON source is a saved draft; only explicitly selected keys are reassessed. */
export async function analyzeJsonLicenses(input: {
  artifact: LicenseArtifact;
  eligibility: LicenseEligibilityRow[];
  classify: ReturnType<typeof createLicenseClassifier>;
  model: string;
  sampleCount: number;
  now?: () => string;
  shouldStop?: () => boolean;
}): Promise<LicenseArtifact> {
  const currentRun: LicenseArtifact['classificationRun'] = {
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
  const selected = new Map(input.eligibility.map((row) => [row.normalizedText, row]));
  const classifications: LicenseClassification[] = [];
  for (const previous of input.artifact.classifications) {
    if (input.shouldStop?.()) throw new LicenseAnalysisStoppedError();
    const eligible = selected.get(previous.normalizedText);
    if (
      !eligible ||
      eligible.action === 'retain' ||
      (eligible.action === 'rule' && !eligible.ruleMatches)
    ) {
      classifications.push(previous);
      continue;
    }
    const proposal = await input.classify(
      eligible.exampleNotice,
      undefined,
      eligible.action === 'model' ? 'model-only' : 'rules-then-model'
    );
    classifications.push(
      assessedLicenseRow({
        normalizedText: previous.normalizedText,
        exampleNotice: eligible.exampleNotice,
        proposal,
        previous,
        previousRun: input.artifact.classificationRun,
        classificationRun: currentRun,
        now: input.now ?? (() => new Date().toISOString()),
      })
    );
  }
  return createLicenseArtifact({ ...input.artifact, classifications });
}
