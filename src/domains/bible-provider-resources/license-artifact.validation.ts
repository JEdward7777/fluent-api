import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';

import type { LicenseArtifact, LicenseClassification } from './license-artifact.schemas';

import { buildLicenseSampleRequest, parseLicenseVote } from './license-model-contract';
import { normalizeLicenseNotice } from './license-normalizer';

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
const modelKey = (provider: string, model: string) => JSON.stringify([provider, model]);

function validateEvidence(row: LicenseClassification, artifact: LicenseArtifact) {
  const proposal = row.source === 'manual' ? row.automaticDecision : row;
  if (!proposal) throw new Error('A manual disposition must preserve its previous decision');
  if (row.source !== 'manual' && row.automaticDecision)
    throw new Error('Only manual dispositions carry an automatic decision');
  if (proposal.source === 'rule') {
    if (
      !row.rule ||
      row.rule.decision !== proposal.status ||
      row.rule.rationale !== proposal.rationale ||
      !row.exampleNotice.includes(row.rule.matchedExcerpt)
    ) {
      throw new Error('Rule evidence does not match its automatic decision and notice');
    }
  } else if (row.rule) throw new Error('Unexpected rule evidence');
  if (proposal.source !== 'gemini' && row.samples.length > 0)
    throw new Error('Unexpected model evidence');
  if (proposal.source !== 'gemini') return;

  const models = artifact.classificationRun.models;
  const expectedCount = models.reduce((count, model) => count + model.sampleCount, 0);
  if (row.samples.length !== expectedCount)
    throw new Error('Incomplete configured model sample set');
  unique(
    row.samples.map((sample) => JSON.stringify([sample.provider, sample.model, sample.index])),
    'sample identity'
  );
  for (const sample of row.samples) {
    const model = models.find(
      (candidate) => candidate.provider === sample.provider && candidate.model === sample.model
    );
    if (!model || sample.index > model.sampleCount)
      throw new Error('Sample does not belong to the configured model/index set');
    if (
      sample.request.provider !== sample.provider ||
      sample.request.model !== sample.model ||
      llmRequestHash(sample.request) !== sample.requestHash
    ) {
      throw new Error('Model request identity or request hash mismatch');
    }
    const expected = buildLicenseSampleRequest(
      row.exampleNotice,
      model.provider,
      model.model,
      sample.index,
      {
        prompt: artifact.classificationRun.prompt,
        responseSchema: artifact.classificationRun.responseSchema,
        settings: model.settings,
      }
    );
    if (llmRequestHash(expected) !== sample.requestHash)
      throw new Error(
        'Model request does not match the recorded notice, prompt, schema, settings and sample index'
      );
    const vote = parseLicenseVote(sample.response);
    if (vote.decision !== sample.result.decision || vote.rationale !== sample.result.rationale)
      throw new Error('Model response does not match its recorded vote');
  }
  const first = row.samples[0].result.decision;
  const consensus =
    first !== 'unknown' && row.samples.every((sample) => sample.result.decision === first)
      ? first
      : 'unknown';
  if (proposal.status !== consensus)
    throw new Error('Classification does not match complete unanimous sample evidence');
}

/** Validate owned facts without rewriting them or trusting extension fields as evidence. */
export function validateLicenseArtifactContent(artifact: LicenseArtifact): void {
  if (
    hashCanonicalJson(artifact.classificationRun.prompt) !== artifact.classificationRun.promptHash
  )
    throw new Error('Recorded prompt hash mismatch');
  unique(
    artifact.classificationRun.models.map((model) => modelKey(model.provider, model.model)),
    'model identity'
  );
  unique(
    artifact.classifications.map((row) => row.normalizedText),
    'normalized classification key'
  );
  unique(
    artifact.catalog.map((bible) => JSON.stringify([bible.provider, bible.externalId])),
    'catalog provider identity'
  );
  unique(
    artifact.catalog
      .filter((bible) => bible.bibleId !== null)
      .map((bible) => String(bible.bibleId)),
    'catalog Bible ID'
  );
  const keys = new Set(artifact.classifications.map((row) => row.normalizedText));
  for (const bible of artifact.catalog) {
    if (
      bible.rawNotice !== null &&
      bible.rawNotice.trim() &&
      !keys.has(normalizeLicenseNotice(bible.rawNotice))
    )
      throw new Error('Catalog notice has no exact normalized classification');
  }
  for (const row of artifact.classifications) {
    if (
      row.normalizedText !== normalizeLicenseNotice(row.normalizedText) ||
      row.normalizedText !== normalizeLicenseNotice(row.exampleNotice)
    )
      throw new Error('Classification key does not match exact notice normalization');
    validateEvidence(row, artifact);
  }
}
