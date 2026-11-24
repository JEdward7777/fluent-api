import type { JsonValue } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';

import { licenseArtifactSchema, licenseClassificationSchema } from '../license-artifact.schemas';

type Fields = Record<string, JsonValue>;
type Contract = LicenseArtifact['classificationRun'];
const runShape = licenseArtifactSchema.shape.classificationRun.shape;
const modelShape = runShape.models.element.shape;
const sampleShape = licenseClassificationSchema.shape.samples.element.shape;

function fields(value: unknown, shape: object): Fields | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entries = Object.entries(value).filter(([key]) => !Object.hasOwn(shape, key));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function object(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function modelKey(model: Contract['models'][number]) {
  return JSON.stringify([model.provider, model.model]);
}

function sampleKey(sample: LicenseClassification['samples'][number]) {
  return JSON.stringify([sample.provider, sample.model, sample.index]);
}

function byIdentity<T>(rows: T[], key: (row: T) => string, shape: object) {
  const entries = rows.flatMap((row) => {
    const extensions = fields(row, shape);
    return extensions ? [[key(row), extensions] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Keep unknown JSON from all passthrough objects outside decision authority and diagnostics. */
export function projectStoredExtensions(row: LicenseClassification, run: Contract) {
  const extensions = fields(row, licenseClassificationSchema.shape);
  const samples = byIdentity(row.samples, sampleKey, sampleShape);
  const contract = row.evidenceContract || row.samples.length || row.rule ? run : undefined;
  const contractFields = fields(contract, runShape);
  const models = contract && byIdentity(contract.models, modelKey, modelShape);
  const nested = samples || contractFields || models;
  if (!extensions && !nested) return;
  return structuredClone({
    ...(extensions ? { extensions } : {}),
    ...(nested
      ? {
          nestedExtensions: {
            ...(samples ? { samples } : {}),
            ...(contractFields ? { contract: contractFields } : {}),
            ...(models ? { models } : {}),
          },
        }
      : {}),
  });
}

/** Property definition keeps literal prototype keys inert and cannot replace a schema-owned field. */
function restore(target: object, value: unknown, shape: object) {
  const extensions = fields(value, shape);
  for (const [key, content] of Object.entries(extensions ?? {})) {
    Object.defineProperty(target, key, {
      value: structuredClone(content),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

export function restoreStoredExtensions(
  row: LicenseClassification,
  fallback: Contract | undefined,
  metadata: Fields
) {
  restore(row, metadata.extensions, licenseClassificationSchema.shape);
  const nested = object(metadata.nestedExtensions);
  if (!nested) return;
  const samples = object(nested.samples);
  if (samples)
    for (const sample of row.samples) restore(sample, samples[sampleKey(sample)], sampleShape);

  const contract =
    row.evidenceContract ??
    ((row.samples.length || row.rule) && fallback ? structuredClone(fallback) : undefined);
  if (!contract) return;
  row.evidenceContract = contract;
  restore(contract, nested.contract, runShape);
  const models = object(nested.models);
  if (models)
    for (const model of contract.models) restore(model, models[modelKey(model)], modelShape);
}
