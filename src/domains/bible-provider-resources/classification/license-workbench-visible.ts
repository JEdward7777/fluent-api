import type { LicenseCommandOptions } from './license-command-options';
import type { LicensePractice } from './license-practice';
import type { WorkbenchDatabase } from './license-workbench-database';
import type { LicenseWorkflow } from './license-workflow';

import { visibleWorkbenchDatabase } from './license-workbench-database';
import { licenseWorkbenchPreviewView } from './license-workbench-preview-view';
import {
  visibleWorkbenchAnalysis,
  visibleWorkbenchInspection,
} from './license-workbench-state-view';

/** Only public session facts are projected; credentials and target prior bytes stay server-side. */
export function visibleLicenseWorkbench(input: {
  options: LicenseCommandOptions;
  loadedOptions?: LicenseCommandOptions;
  workflow?: LicenseWorkflow;
  launchId: string;
  practiceMode: boolean;
  practice?: LicensePractice;
  selectedPracticePath: string | null;
  configurationRevision: number;
  databaseTarget: string;
  loadedDatabaseTarget: string | null;
  destinationDatabaseTarget: string;
  databaseConnection: WorkbenchDatabase;
  databaseTest: 'untested' | 'passed' | 'failed';
  testingDatabase: boolean;
  activeOperationId?: string;
  latestOperation: unknown;
  saveOutcome: unknown;
}) {
  const { options, workflow } = input;
  const status = workflow?.status;
  const inspected =
    status && !['configuring', 'error', 'closed'].includes(status.state)
      ? workflow?.inspectedSource
      : undefined;
  return {
    step: 'Choose inputs',
    launchId: input.launchId,
    practice: input.practiceMode,
    scratch: input.practice?.scratch ?? null,
    originalHash: input.practice?.originalHash ?? null,
    selectedSource: input.selectedPracticePath,
    state: status?.state ?? 'configuring',
    configurationRevision: input.configurationRevision,
    contentRevision: status?.contentRevision ?? 0,
    hasPaidCredential: workflow?.hasPaidCredential ?? false,
    readyForInspect: Boolean(options.source),
    source: options.source ?? null,
    destination: options.destination ?? null,
    input: input.practiceMode ? (input.selectedPracticePath ?? 'Bundled example') : options.input,
    output: input.practiceMode
      ? (input.practice?.options.output ?? 'Allocated after Inspect')
      : options.output,
    sampleCount: options.sampleCount,
    model: options.model,
    force: options.force,
    noCache: options.noCache,
    cacheDir: options.cacheDir ?? null,
    reportFormats: options.reportFormats,
    reportDir: options.reportDir ?? null,
    preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
    databaseTarget: input.databaseTarget,
    databaseConnection: visibleWorkbenchDatabase(input.databaseConnection),
    databaseTest: input.databaseTest,
    testingDatabase: input.testingDatabase,
    inspected: visibleWorkbenchInspection(inspected),
    analysis: visibleWorkbenchAnalysis(workflow?.analyzed, workflow?.reviewDrafts.size ?? 0),
    preview: licenseWorkbenchPreviewView({
      workflow,
      loadedDatabaseTarget: input.loadedDatabaseTarget,
      destinationDatabaseTarget: input.destinationDatabaseTarget,
      options: input.loadedOptions ?? options,
      configurationRevision: input.configurationRevision,
      practiceMode: input.practiceMode,
    }),
    sourceChanged: workflow?.sourceChanged ?? false,
    saveOutcome: input.saveOutcome,
    activeOperationId: input.activeOperationId ?? null,
    latestOperation: input.latestOperation,
  };
}
