import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReviewEdit } from './license-workflow.types';

import { overrideLicenseClassification, reviseLicenseArtifact } from '../license-artifact';
import { freezeLicenseRevision } from '../license-review-revision';

export function applyLicenseReviewEdit(before: LicenseArtifact, edit: LicenseReviewEdit) {
  let revised: LicenseArtifact;
  let warning: string | null = null;
  if (edit.kind === 'disposition') {
    const result = overrideLicenseClassification(
      before,
      edit.normalizedText,
      edit.status,
      edit.reason,
      edit.unknownNote
    );
    revised = result.artifact;
    warning = result.warning;
  } else {
    if (!edit.note.trim()) throw new Error('A retained unknown requires a nonempty human note');
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
