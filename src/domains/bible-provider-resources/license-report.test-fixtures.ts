import type { LicenseDatabaseContext } from './license-impact';

import { reviseLicenseArtifact } from './license-artifact';
import { makeLicenseArtifact } from './license-artifact.test-fixtures';

export function makeLicenseImpactFixture() {
  const artifact = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
    draft.catalog.push({
      ...draft.catalog[0],
      externalId: 'new-text',
      bibleId: 4,
      name: 'New Bible',
      abbreviation: 'NEW',
      rawNotice: draft.catalog[0].rawNotice!.replace('2026', '2025'),
    });
  });
  const database: LicenseDatabaseContext = {
    label: 'QA snapshot supplied for comparison',
    resources: [
      {
        ...artifact.catalog[0],
        rawNotice: 'Earlier licensing notice.',
        ttsLicenseStatus: 'allowed',
      },
      { ...artifact.catalog[1], ttsLicenseStatus: 'forbidden' },
      { ...artifact.catalog[2], ttsLicenseStatus: 'unknown' },
      {
        provider: 'dbl',
        externalId: 'retained',
        bibleId: 99,
        name: 'Retained database Bible',
        abbreviation: 'RET',
        rawNotice: 'Unclassified retained notice.',
        ttsLicenseStatus: 'allowed',
      },
    ],
  };
  return { artifact, database };
}
