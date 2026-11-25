import { isDeepStrictEqual } from 'node:util';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReviewDrafts } from './license-review-drafts';

import { createLicenseArtifact } from '../license-artifact';
import { licenseRowRevision } from '../license-review-revision';
import { licenseReviewRowId } from './license-workbench-review';

type Side = 'working' | 'source' | 'source-with-mark';
interface Change {
  id: string;
  label: string;
  original: unknown;
  working: unknown;
  source: unknown;
  conflict: boolean;
  proposed: Side;
  pending?: ReturnType<LicenseReviewDrafts['values']>;
}

function records(artifact: LicenseArtifact) {
  return new Map(
    artifact.classifications.map((row) => [
      row.normalizedText,
      licenseRowRevision(row, artifact.classificationRun),
    ])
  );
}

function catalog(artifact: LicenseArtifact) {
  return new Map(
    artifact.catalog.map((row) => [JSON.stringify([row.provider, row.externalId]), row])
  );
}

function metadata(artifact: LicenseArtifact) {
  return new Map(
    Object.entries(artifact).filter(
      ([key]) => !['catalog', 'classifications', 'reviewContentHash', 'reviewState'].includes(key)
    )
  );
}

export function mergeLicenseSources(
  original: LicenseArtifact,
  working: LicenseArtifact,
  source: LicenseArtifact,
  drafts: Pick<LicenseReviewDrafts, 'values'>,
  choices: ReadonlyMap<string, Side>
) {
  const changes: Change[] = [];
  const discard: string[] = [];
  function merge<T>(
    group: string,
    before: Map<string, T>,
    local: Map<string, T>,
    remote: Map<string, T>,
    overlay?: (key: string) => ReturnType<LicenseReviewDrafts['values']> | undefined
  ) {
    const merged = new Map<string, T>();
    for (const key of new Set([...local.keys(), ...remote.keys(), ...before.keys()])) {
      const base = before.get(key);
      const left = local.get(key);
      const right = remote.get(key);
      const pending = overlay?.(key);
      const localChanged = !isDeepStrictEqual(base, left);
      const remoteChanged = !isDeepStrictEqual(base, right);
      const divergent = !isDeepStrictEqual(left, right);
      const conflict = divergent && remoteChanged && (localChanged || Boolean(pending));
      const id = licenseReviewRowId(JSON.stringify([group, key]));
      const proposed = localChanged || pending ? 'working' : 'source';
      if (remoteChanged || localChanged || pending)
        changes.push({
          id,
          label: `${group} ${key}`,
          original: base ?? null,
          working: left ?? null,
          source: right ?? null,
          pending,
          conflict,
          proposed,
        });
      const side = choices.get(id) ?? proposed;
      const chosen = side === 'working' ? left : right;
      if (chosen !== undefined) merged.set(key, chosen);
      if (side === 'source-with-mark' && (!pending || !right))
        throw new Error('Cannot apply this mark to the selected source');
      if (pending && choices.get(id) === 'source') discard.push(key);
    }
    return merged;
  }
  const localRows = records(working);
  const rows = merge('Classification', records(original), localRows, records(source), (key) => {
    const row = localRows.get(key);
    const values = row && drafts.values(row.row);
    return values?.pending ? values : undefined;
  });
  const catalogRows = merge('Catalog', catalog(original), catalog(working), catalog(source));
  const fields = Object.fromEntries(
    merge('Artifact', metadata(original), metadata(working), metadata(source))
  );
  const finish = () => {
    if (changes.some((change) => change.conflict && !choices.has(change.id)))
      throw new Error('Choose a version for each conflicting change');
    const run = fields.classificationRun as LicenseArtifact['classificationRun'];
    const classifications = [...rows.values()].map(({ row, inheritedContract }) =>
      inheritedContract && !isDeepStrictEqual(run, inheritedContract)
        ? { ...row, evidenceContract: inheritedContract }
        : row
    );
    const merged = createLicenseArtifact({
      ...fields,
      classificationRun: run,
      classifications,
      catalog: [...catalogRows.values()],
    });
    const assertion = fields.attestation as LicenseArtifact['attestation'];
    if (assertion?.reviewContentHash === merged.reviewContentHash) {
      merged.attestation = assertion;
      delete merged.reviewState;
    }
    return isDeepStrictEqual(merged, source) ? source : merged;
  };
  return { changes, discard, finish };
}
