import type { LicenseCommandOptions } from './license-command-options';

import { licenseKeyDigest } from './license-eligibility';

export function selectedLicenseRerunOptions(
  options: LicenseCommandOptions,
  normalizedText: string,
  kind: 'rule' | 'model'
): LicenseCommandOptions {
  const digest = licenseKeyDigest(normalizedText);
  return {
    ...options,
    rerunRule: kind === 'rule' ? [digest] : [],
    rerunModel: kind === 'model' ? [digest] : [],
  };
}
