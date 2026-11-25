import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseContext } from '../license-impact';
import type { DraftCommand } from './license-review-drafts';
import type {
  LicenseAnalysis,
  LicensePreview,
  LicenseReviewEdit,
  LicenseWorkflowDependencies,
  LicenseWorkflowState,
} from './license-workflow.types';

import {
  attestLicenseArtifact,
  licenseOverrideWarning,
  recordAnonymousLicenseNote,
  recordHumanLicenseDecision,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from '../license-artifact';
import { freezeLicenseRevision, freezeReviewValue } from '../license-review-revision';
import { LicenseReviewDrafts } from './license-review-drafts';
import { licenseReviewRowId, listLicenseWorkbenchReview } from './license-workbench-review';

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
  constructor(protected readonly dependencies: LicenseWorkflowDependencies) {}
  private finishBusy?: () => void;
  protected configurationRevision = 1;
  abstract get reviewDatabaseContext(): LicenseDatabaseContext | undefined;
  private stateBeforeDrafts: LicenseWorkflowState = 'reviewing';
  private drafts = new LicenseReviewDrafts();
  get status() {
    return freezeReviewValue({
      state: this.state,
      configurationRevision: this.configurationRevision,
      contentRevision: this.contentRevision,
    });
  }
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
  protected acceptPreparedRows(keys: string[]) {
    this.drafts.removeReplaced(keys);
    this.stateBeforeDrafts = 'reviewing';
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
    const result = this.drafts.apply(
      command,
      row,
      this.contentRevision,
      writable,
      (query, marked) => {
        const view = listLicenseWorkbenchReview(
          analysis.artifact,
          query,
          this.reviewDatabaseContext,
          false,
          {
            values: (candidate) => (candidate === row ? marked : this.drafts.values(candidate)),
          },
          row.normalizedText
        );
        return {
          nextEligibleId: view.navigation!.nextEligibleId,
          remaining: view.remaining,
          total: view.total,
          page: view.page,
        };
      }
    );
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
  editReview(
    edit: LicenseReviewEdit,
    expectedConfigurationRevision: number,
    expectedContentRevision: number
  ) {
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (!this.analysis || !['inspected', 'reviewing', 'previewed'].includes(this.state))
      throw new Error(`Cannot edit review while ${this.state}`);
    if (this.reviewDrafts.size)
      throw new Error('Revert pending session edits before using this operation');
    const before = this.analysis.artifact;
    const { artifact, warning } = applyLicenseReviewEdit(
      before,
      edit,
      this.dependencies.now ?? (() => new Date().toISOString())
    );
    if (serializeLicenseArtifact(artifact).bytes !== serializeLicenseArtifact(before).bytes) {
      this.analysis = freezeReviewValue({
        ...this.analysis,
        contentRevision: ++this.contentRevision,
        artifact,
      });
      this.previewResult = undefined;
      this.state = 'reviewing';
    }
    return freezeReviewValue({ analysis: this.analysis, warning });
  }

  attest(
    metadata: { reviewedBy: string; reviewReason: string; reviewedAt: string },
    expectedConfigurationRevision: number,
    expectedContentRevision: number,
    expectedReviewHash: string
  ) {
    if (this.dependencies.practice) throw new Error('Practice cannot attest a review');
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (!this.analysis || this.state !== 'previewed' || !this.previewResult)
      throw new Error('Preview this exact revision before attestation');
    if (this.analysis.artifact.reviewContentHash !== expectedReviewHash)
      throw new Error('Stale license review hash');
    if (!metadata.reviewedBy.trim() || !metadata.reviewReason.trim())
      throw new Error('Reviewer identity and review reason are required');
    const artifact = freezeLicenseRevision(attestLicenseArtifact(this.analysis.artifact, metadata));
    if (
      serializeLicenseArtifact(artifact).bytes !==
      serializeLicenseArtifact(this.analysis.artifact).bytes
    )
      this.analysis = freezeReviewValue({
        ...this.analysis,
        contentRevision: ++this.contentRevision,
        artifact,
      });
    this.previewResult = undefined;
    this.state = 'reviewing';
    return this.analysis;
  }

  protected requireRevision(expectedRevision: number) {
    if (expectedRevision !== this.configurationRevision)
      throw new Error('Stale license workflow configuration revision');
    if (this.state === 'closed' || this.closing) throw new Error('License workflow is closed');
  }

  protected requireContentRevision(
    expectedConfigurationRevision: number,
    expectedContentRevision: number
  ) {
    this.requireRevision(expectedConfigurationRevision);
    if (expectedContentRevision !== this.contentRevision)
      throw new Error('Stale license workflow content revision');
  }

  protected beginBusy() {
    this.busyDone = new Promise<void>((resolve) => {
      this.finishBusy = resolve;
    });
  }

  protected endBusy() {
    this.finishBusy?.();
    this.finishBusy = undefined;
    this.busyDone = undefined;
  }
}
