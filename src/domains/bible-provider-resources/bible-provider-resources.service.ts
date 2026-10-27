import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';
import type { DbTransaction } from '@/lib/types';

import type { DblTextLicenseFact } from './bible-provider-resources.repository';
import type { Provider, ProviderIdentity } from './bible-provider-resources.types';

import * as repo from './bible-provider-resources.repository';

export function getById(id: number) {
  return repo.getById(id);
}

export function getByProviderIdentity(provider: Provider, externalId: string) {
  return repo.getByProviderIdentity(provider, externalId);
}

export function getByIds(ids: number[]) {
  return repo.getByIds(ids);
}

export function getByProviderIdentities(identities: ProviderIdentity[]) {
  return repo.getByProviderIdentities(identities);
}

export function upsertDblTextFacts(
  facts: DblTextLicenseFact[],
  initialStatus: TtsLicenseStatus,
  tx: DbTransaction,
  statuses?: ReadonlyMap<string, TtsLicenseStatus>
) {
  return repo.upsertDblTextFacts(facts, initialStatus, tx, statuses);
}

export function applyAllRightsReservedSweep() {
  return repo.applyAllRightsReservedSweep();
}

export function getDblPolicyFacts(externalIds: string[], tx: DbTransaction) {
  return repo.getDblPolicyFacts(externalIds, tx);
}
