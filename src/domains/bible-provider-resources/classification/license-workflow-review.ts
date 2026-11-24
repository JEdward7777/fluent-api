import type { LicenseArtifact } from '../license-artifact.schemas';
import type { DraftCommand } from './license-review-drafts';
import type {
  LicenseAnalysis,
  LicensePreview,
  LicenseReviewEdit,
  LicenseWorkflowState,
} from './license-workflow.types';

import {
  licenseOverrideWarning,
  recordAnonymousLicenseNote,
  recordHumanLicenseDecision,
  reviseLicenseArtifact,
} from '../license-artifact';
import { freezeLicenseRevision } from '../license-review-revision';
import { LicenseReviewDrafts } from './license-review-drafts';
import { licenseReviewRowId } from './license-workbench-review';

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
    revised = recordAnonymousLicenseNote(before, edit.normalizedText, edit.note);
  }
  return { artifact: freezeLicenseRevision(revised), warning };
}

export abstract class LicenseWorkflowReview {
  private stateBeforeDrafts: LicenseWorkflowState = 'reviewing';
  private drafts = new LicenseReviewDrafts();
  get analyzed() {
    return this.analysis;
  }
  get reviewDrafts(): Pick<LicenseReviewDrafts, 'epoch' | 'size' | 'values'> {
    return this.drafts;
  }
  protected analysis?: LicenseAnalysis;
  protected previewResult?: LicensePreview;
  protected contentRevision = 0;
  protected state: LicenseWorkflowState = 'configuring';
  protected closing = false;
  protected busyDone?: Promise<void>;

  protected invalidateConfiguredPreview() {
    this.previewResult = undefined;
    if (!this.analysis) return;
    if (this.drafts.size) {
      if (this.stateBeforeDrafts !== 'inspected') this.stateBeforeDrafts = 'reviewing';
    } else if (this.state !== 'inspected') this.state = 'reviewing';
  }
  protected resetDrafts() {
    this.drafts = new LicenseReviewDrafts();
  }
  mutateDraft(command: DraftCommand, available: boolean) {
    const analysis = this.analysis;
    const row = analysis?.artifact.classifications.find(
      (item) => licenseReviewRowId(item.normalizedText) === command.id
    );
    if (!analysis || !row)
      return {
        id: command.id,
        mutationId: command.mutationId,
        epoch: this.drafts.epoch,
        contentRevision: this.contentRevision,
        conflict: true as const,
        values: null,
      };
    const writable =
      available &&
      !this.busyDone &&
      !this.closing &&
      ['inspected', 'reviewing', 'previewed', 'saved'].includes(this.state);
    const hadDrafts = this.drafts.size > 0;
    const result = this.drafts.apply(command, row, this.contentRevision, writable);
    if (!result.conflict && result.contentRevision > this.contentRevision) {
      this.contentRevision = result.contentRevision;
      this.analysis = Object.freeze({ ...analysis, contentRevision: this.contentRevision });
      this.previewResult = undefined;
      if (!hadDrafts)
        this.stateBeforeDrafts = this.state === 'previewed' ? 'reviewing' : this.state;
      this.state = this.drafts.size ? 'reviewing' : this.stateBeforeDrafts;
    }
    return result;
  }
}
