/** Version the exact shared normalization contract when its semantics change. */
export const LICENSE_NORMALIZER_VERSION = 1;

export function normalizeLicenseNotice(notice: string): string {
  return notice
    .toLowerCase()
    .replace(/©|\(c\)|\bcopyright\b|\b\d{4}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
