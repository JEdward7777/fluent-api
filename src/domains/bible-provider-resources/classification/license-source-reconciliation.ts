import { randomUUID } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseReviewDrafts } from './license-review-drafts';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicenseWorkflowDependencies,
} from './license-workflow.types';

import { freezeReviewValue } from '../license-review-revision';
import { sameLicenseRelation } from './license-database-identity';
import { inspectLicenseFile, matchesLicenseFile } from './license-file-identity';
import { requireFreshLicenseSources } from './license-freshness';
import { mergeLicenseSources } from './license-source-merge';
import { LicenseWorkflowDestination } from './license-workflow-destination';
import {
  inspectLoadedLicensePreflight,
  inspectWorkingLicensePreflight,
  loadedLicenseReview,
} from './license-workflow-inspect';
import { LicenseWorkflowPreparation } from './license-workflow-preparation';
import { licenseFileIo } from './license-write';

async function inspectSourceReconciliation(
  inspection: LicenseInspection,
  analysis: LicenseAnalysis,
  options: LicenseCommandOptions,
  deps: LicenseWorkflowDependencies,
  database: LicenseDatabaseAdapter | undefined,
  drafts: Pick<LicenseReviewDrafts, 'values'>
) {
  const inputIdentity = inspection.inputIdentity
    ? await inspectLicenseFile(inspection.inputIdentity.path, inspection.inputIdentity.root)
    : undefined;
  if (inputIdentity && inputIdentity.canonical !== inspection.inputIdentity?.canonical)
    throw new Error('Source path now points to a different target. Select and load it explicitly.');
  const fresh: LicenseInspection = {
    ...inspection,
    inputIdentity,
    inputBytes:
      options.source === 'json'
        ? await (deps.fs ?? licenseFileIo).read(inputIdentity?.canonical ?? options.input)
        : null,
    database:
      options.source === 'database'
        ? {
            ...(await database!.load('source', inspection.database?.sourceMarker)),
            sourceMarker: inspection.database?.sourceMarker,
          }
        : undefined,
  };
  if (
    fresh.database &&
    !sameLicenseRelation(fresh.database.relation, inspection.database?.relation)
  )
    throw new Error('The loaded database relation changed. Select and load it explicitly.');
  fresh.inspectedAt = deps.now?.() ?? new Date().toISOString();
  if (inputIdentity && !(await matchesLicenseFile(inputIdentity)))
    throw new Error('Source changed during reconciliation. Inspect the changes again.');
  const [original, source] = await Promise.all([
    loadedLicenseReview(inspection, options, analysis.contentRevision),
    loadedLicenseReview(fresh, options, analysis.contentRevision),
  ]);
  const merge = (choices: ReadonlyMap<string, 'working' | 'source' | 'source-with-mark'>) =>
    mergeLicenseSources(original.artifact, analysis.artifact, source.artifact, drafts, choices);
  return {
    token: randomUUID(),
    analysis,
    fresh,
    source,
    merge,
    changes: merge(new Map()).changes,
  };
}

export abstract class LicenseSourceReconciliation extends LicenseWorkflowPreparation {
  get inspectedSource() {
    return this.inspection;
  }
  protected database?: LicenseDatabaseAdapter;
  protected readonly destination = new LicenseWorkflowDestination();
  protected proposal?: Awaited<ReturnType<typeof inspectSourceReconciliation>>;
  get sourceChanged() {
    return this.sourceDrift;
  }

  async reconcileSource(resolution?: {
    token: string;
    choices: Record<string, 'working' | 'source' | 'source-with-mark'>;
  }) {
    if (
      this.busyDone ||
      this.closing ||
      this.state !== 'reviewing' ||
      !this.sourceDrift ||
      !this.inspection?.sourceOnly ||
      !this.analysis
    )
      throw new Error('Source reconciliation is unavailable');
    this.beginBusy();
    try {
      if (!resolution) {
        this.proposal = await inspectSourceReconciliation(
          this.inspection,
          this.analysis,
          this.options,
          this.dependencies,
          this.database,
          this.reviewDrafts
        );
        return { token: this.proposal.token, changes: this.proposal.changes };
      }
      const proposal = this.proposal;
      if (!proposal || proposal.token !== resolution.token || proposal.analysis !== this.analysis)
        throw new Error('Reconciliation changed. Inspect the changes again.');
      const merged = proposal.merge(new Map(Object.entries(resolution.choices)));
      const artifact = merged.finish();
      const preflight = await inspectWorkingLicensePreflight(artifact, this.options);
      await requireFreshLicenseSources(
        proposal.fresh,
        this.options,
        this.dependencies.fs ?? licenseFileIo,
        this.database,
        false,
        proposal.fresh.database?.sourceMarker
      );
      this.analysis = freezeReviewValue({
        ...this.analysis,
        artifact,
        originalSourceArtifact: proposal.source.artifact,
        contentRevision: ++this.contentRevision,
      });
      this.acceptPreparedRows(merged.discard);
      this.inspection = freezeReviewValue({ ...proposal.fresh, preflight });
      this.invalidatePaidEstimate();
      this.reconcileCompletedSelections(artifact, preflight);
      this.previewResult = undefined;
      this.sourceDrift = false;
      this.proposal = undefined;
      return { accepted: true };
    } finally {
      this.endBusy();
    }
  }

  async configureLoadedSettings(
    options: LicenseCommandOptions,
    destinationChanged: boolean,
    aiChanged: boolean
  ) {
    this.requireRevision(this.configurationRevision);
    if (this.busyDone || this.state === 'uncertain')
      throw new Error('Cannot configure while an operation runs');
    this.beginBusy();
    try {
      const preflight =
        aiChanged && this.inspection
          ? this.inspection.sourceOnly && this.analysis
            ? await inspectWorkingLicensePreflight(this.analysis.artifact, options)
            : await inspectLoadedLicensePreflight(options, this.inspection)
          : undefined;
      if (destinationChanged) await this.destination.release(this.database);
      if (preflight && this.inspection)
        this.inspection = freezeReviewValue({ ...this.inspection, preflight });
      this.options = freezeReviewValue(options);
      this.proposal = undefined;
      if (aiChanged) {
        this.invalidatePaidEstimate();
        this.completedLaunchSelections.clear();
      }
      this.invalidateConfiguredPreview();
      return this.inspection;
    } finally {
      this.endBusy();
    }
  }
}
