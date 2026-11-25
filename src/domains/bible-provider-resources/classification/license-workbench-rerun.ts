import type { FreeSelection } from './license-free-preparation';

export interface LicenseRerunSelection extends FreeSelection {
  operationId?: string;
  configurationRevision: number;
  contentRevision: number;
  cancel?: true;
  discardReviewedState?: boolean;
}
