import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReviewEdit } from './license-workflow.types';

import {
  licenseOverrideWarning,
  recordHumanLicenseDecision,
  reviseLicenseArtifact,
} from '../license-artifact';
import { freezeLicenseRevision } from '../license-review-revision';

export function applyLicenseReviewEdit(
  before: LicenseArtifact,
  edit: LicenseReviewEdit,
  now: () => string = () => new Date().toISOString()
) {
  let revised: LicenseArtifact;
  let warning: string | null = null;
  if (edit.kind === 'disposition') {
    const prior = before.classifications.find((row) => row.normalizedText === edit.normalizedText);
    if (!prior) throw new Error('No exact normalized classification exists');
    warning = licenseOverrideWarning(prior, edit.status);
    revised = recordHumanLicenseDecision(
      before,
      edit.normalizedText,
      edit.status,
      edit.reason,
      edit.reviewedBy ?? '',
      now()
    );
    if (edit.unknownNote !== undefined) {
      if (edit.status !== 'unknown' || !edit.unknownNote.trim())
        throw new Error('A human note must be nonempty and requires unknown status');
      revised = reviseLicenseArtifact(revised, (draft) => {
        draft.classifications.find((row) => row.normalizedText === edit.normalizedText)!.rowNote =
          edit.unknownNote;
      });
    }
  } else {
    if (!edit.note.trim()) throw new Error('A human note must be nonempty');
    const row = before.classifications.find(
      (candidate) => candidate.normalizedText === edit.normalizedText
    );
    if (!row) throw new Error('No exact normalized classification exists');
    if (row.status !== 'unknown')
      throw new Error('Human row notes are for retained unknown classifications');
    revised = reviseLicenseArtifact(before, (draft) => {
      draft.classifications.find(
        (candidate) => candidate.normalizedText === edit.normalizedText
      )!.rowNote = edit.note;
    });
  }
  return { artifact: freezeLicenseRevision(revised), warning };
}
