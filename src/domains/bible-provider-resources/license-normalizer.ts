import type { LicenseArtifact } from './license-artifact.schemas';

/** Version the exact shared normalization contract when its semantics change. */
export const LICENSE_NORMALIZER_VERSION = 1;

export function normalizeLicenseNotice(notice: string): string {
  return notice
    .toLowerCase()
    .replace(/©|\(c\)|\bcopyright\b|\b\d{4}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keys are one-pass normalization outputs and need not be fixed points. */
export function indexLicenseNoticeExamples(notices: Iterable<string | null>) {
  const examples = new Map<string, string>();
  for (const notice of notices) {
    if (notice === null) continue;
    const key = normalizeLicenseNotice(notice);
    if (!examples.has(key)) examples.set(key, notice);
  }
  return examples;
}

export function savedLicenseNotices(
  artifact?: Pick<LicenseArtifact, 'catalog' | 'classifications'>
) {
  return artifact
    ? [
        ...catalogLicenseNotices(artifact.catalog),
        ...artifact.classifications.map((row) => row.exampleNotice),
      ]
    : [];
}

export function catalogLicenseNotices(resources: Iterable<{ rawNotice: string | null }>) {
  return Array.from(resources).flatMap((row) => (row.rawNotice?.trim() ? [row.rawNotice] : []));
}

export function isLicenseNoticeUnavailable(notice: string | null): notice is null {
  return notice === null;
}

export function displayLicenseNotice(notice: string | null) {
  return notice === null ? 'Original notice unavailable' : notice || '(empty original notice)';
}
