import { checkLicenseArtifactReview } from './license-artifact';

/** Freeze detached data, including nested extensions, without retaining caller-owned aliases. */
export function freezeReviewValue<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

export function freezeLicenseRevision(value: unknown) {
  const checked = checkLicenseArtifactReview(value);
  if (checked.status === 'invalid') throw new Error(checked.reason);
  return freezeReviewValue(checked.artifact);
}
