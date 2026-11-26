import type { z } from 'zod';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicensePractice } from './license-practice';
import type { WorkbenchDatabase } from './license-workbench-database';
import type { RecordedOperation } from './license-workbench-operation.types';
import type { LicenseRerunSelection } from './license-workbench-rerun';
import type { LicenseReviewQuery } from './license-workbench-review';
import type { inspectOperationSchema, setupSchema } from './license-workbench-schema';
import type { LicenseWorkflow } from './license-workflow';
import type { LicenseWorkflowDependencies } from './license-workflow.types';

import {
  selectWorkbenchDatabase,
  visibleWorkbenchDatabase,
  workbenchDatabaseIdentity,
} from './license-workbench-database';
import {
  DatabaseTestUnavailableError,
  LicenseWorkbenchDatabaseTests,
} from './license-workbench-database-tests';
import { LicenseWorkbenchReports } from './license-workbench-reports';
import {
  licenseWorkbenchReviewDetail,
  licenseWorkbenchReviewList,
} from './license-workbench-review-view';
import { applyLicenseWorkbenchOptions } from './license-workbench-schema';
import { visibleLicenseWorkbench } from './license-workbench-visible';
import { LicenseOperationRegistry } from './license-workflow-operations';
function legacyDatabaseRole(options: Pick<LicenseCommandOptions, 'source' | 'destination'>) {
  return options.source !== 'database' &&
    (options.destination === 'database' || options.destination === 'both')
    ? 'destination'
    : 'source';
}

export class LicenseWorkbenchConfiguration {
  protected options: LicenseCommandOptions;
  private readonly launchId = randomUUID();
  protected workflow?: LicenseWorkflow;
  protected configurationRevision = 1;

  protected databaseConnection: WorkbenchDatabase = { mode: 'environment' };
  protected readonly databaseTests = new LicenseWorkbenchDatabaseTests();
  protected destinationConnection: WorkbenchDatabase = { mode: 'environment' };
  protected readonly destinationTests = new LicenseWorkbenchDatabaseTests();
  protected destinationInitialized = false;
  private sourceRevision = 1;
  private sourceConnectionRevision = 1;
  protected destinationConnectionRevision = 1;
  protected loadedPracticePath?: string | null;
  protected destinationRevision = 1;
  private aiRevision = 1;
  protected loadRevision = 0;
  private lastSourceLoad?: { operationId: string; sourceRevision: number };
  protected loadedOptions?: LicenseCommandOptions;
  protected loadedConnection?: WorkbenchDatabase;
  protected discardRevision?: number;
  protected candidateSource(draft?: z.infer<typeof inspectOperationSchema>['sourceSettings']) {
    if (this.practiceMode && draft?.source === 'database')
      throw new Error('Practice requires a JSON source');
    const options = draft
      ? {
          ...this.options,
          source: draft.source,
          ...(draft.source === 'json' && !this.practiceMode ? { input: draft.input } : {}),
        }
      : this.options;
    const connection =
      draft?.source === 'database' && draft.connection
        ? selectWorkbenchDatabase(this.databaseConnection, draft.connection)
        : this.databaseConnection;
    const practicePath =
      this.practiceMode && draft?.source === 'json'
        ? draft.input === 'Bundled example'
          ? null
          : draft.input
        : this.selectedPracticePath;
    const replacesLoaded = this.practiceMode
      ? this.loadedPracticePath !== undefined && this.loadedPracticePath !== practicePath
      : Boolean(
          this.loadedOptions &&
          (this.loadedOptions.source !== options.source ||
            (options.source === 'database'
              ? !isDeepStrictEqual(this.loadedConnection, connection)
              : this.loadedOptions.input !== options.input))
        );
    return { options, connection, practicePath, replacesLoaded };
  }
  protected acceptSource(
    source: ReturnType<LicenseWorkbenchConfiguration['candidateSource']>,
    operationId: string
  ) {
    const connectionChanged = !isDeepStrictEqual(this.databaseConnection, source.connection);
    const changed =
      connectionChanged ||
      this.options.source !== source.options.source ||
      this.options.input !== source.options.input ||
      this.selectedPracticePath !== source.practicePath;
    if (connectionChanged) this.sourceConnectionRevision++;
    if (changed) {
      this.sourceRevision++;
      this.databaseTests.appliedStatus = 'untested';
    }
    this.lastSourceLoad = { operationId, sourceRevision: this.sourceRevision };
    this.databaseConnection = source.connection;
    this.selectedPracticePath = source.practicePath;
    this.options = source.options;
    return changed;
  }
  protected get sourceDraftPending() {
    return this.candidateSource().replacesLoaded;
  }
  protected preparing = false;
  protected async reserve<T>(work: () => Promise<T>) {
    if (this.preparing || this.closed)
      throw new Error('Cannot configure while an operation runs or the session is closed');
    this.preparing = true;
    try {
      return await this.databaseTests.reserve(() => this.destinationTests.reserve(work));
    } finally {
      this.preparing = false;
    }
  }
  protected get testing() {
    return this.databaseTests.running || this.destinationTests.running;
  }
  protected closed = false;
  private legacyRerun?: { fingerprint: string; operationId: string; revision?: number };
  protected readonly rerunOperations = new LicenseOperationRegistry();
  protected readonly operations = new Map<string, RecordedOperation>();
  protected activeOperationId?: string;
  protected latestOperationId?: string;
  protected latestSaveOperationId?: string;
  protected practice?: LicensePractice;
  protected readonly practiceMode: boolean;
  protected selectedPracticePath: string | null;
  readonly reports = new LicenseWorkbenchReports();
  constructor(
    options: LicenseCommandOptions,
    practiceMode = false,
    protected readonly injected?: Pick<
      LicenseWorkflowDependencies,
      'apiKey' | 'database' | 'destinationDatabase' | 'transport' | 'fs' | 'now'
    >
  ) {
    this.options = { ...options };
    this.practiceMode = practiceMode;
    this.selectedPracticePath = practiceMode && options.input !== '' ? options.input : null;
    if (practiceMode)
      this.options = {
        ...options,
        source: 'json',
        destination: 'json',
        force: false,
        noCache: false,
        cacheDir: undefined,
        reportDir: undefined,
        reportFormats: 'none',
        preserveExistingNonUnknowns: false,
      };
  }
  private databaseRole(role = legacyDatabaseRole(this.options)) {
    return role === 'destination'
      ? { connection: this.destinationConnection, tests: this.destinationTests }
      : { connection: this.databaseConnection, tests: this.databaseTests };
  }
  get visible() {
    const legacy = this.databaseRole();
    return {
      sourceDraftPending: this.sourceDraftPending,
      paidEstimate: this.sourceDraftPending ? null : (this.workflow?.paidEstimate ?? null),
      loadedSource: this.loadedOptions
        ? {
            source: this.loadedOptions.source,
            input:
              this.practice?.selectedSource ??
              (this.loadedOptions.source === 'json' ? this.loadedOptions.input : null),
            databaseConnection:
              this.loadedOptions.source === 'database' && this.loadedConnection
                ? visibleWorkbenchDatabase(this.loadedConnection)
                : null,
          }
        : null,
      sourceRevision: this.sourceRevision,
      sourceConnectionRevision: this.sourceConnectionRevision,
      destinationConnectionRevision: this.destinationConnectionRevision,
      destinationRevision: this.destinationRevision,
      aiRevision: this.aiRevision,
      loadRevision: this.loadRevision,
      lastSourceLoad: this.lastSourceLoad,
      sourceDatabaseTarget: workbenchDatabaseIdentity(this.databaseConnection),
      destinationDatabaseTarget: workbenchDatabaseIdentity(this.destinationConnection),
      sourceDatabaseConnection: visibleWorkbenchDatabase(this.databaseConnection),
      destinationDatabaseConnection: visibleWorkbenchDatabase(this.destinationConnection),
      sourceDatabaseTest: this.databaseTests.appliedStatus,
      destinationDatabaseTest: this.destinationTests.appliedStatus,
      ...visibleLicenseWorkbench({
        options: this.options,
        loadedOptions: this.loadedOptions,
        workflow: this.workflow,
        launchId: this.launchId,
        practiceMode: this.practiceMode,
        practice: this.practice,
        selectedPracticePath: this.selectedPracticePath,
        configurationRevision: this.configurationRevision,
        databaseTarget: this.practiceMode
          ? 'Offline practice: no database connection or provider requests'
          : workbenchDatabaseIdentity(legacy.connection),
        loadedDatabaseTarget: this.loadedConnection
          ? workbenchDatabaseIdentity(this.loadedConnection)
          : null,
        destinationDatabaseTarget: workbenchDatabaseIdentity(this.destinationConnection),
        databaseConnection: legacy.connection,
        databaseTest: legacy.tests.appliedStatus,
        testingDatabase: this.testing,
        saveOutcome: this.latestSaveOperationId ? this.operation(this.latestSaveOperationId) : null,
        activeOperationId: this.activeOperationId,
        latestOperation: this.latestOperationId ? this.operation(this.latestOperationId) : null,
      }),
    };
  }
  operation(id: string) {
    return structuredClone(this.operations.get(id)?.snapshot ?? null);
  }
  listReview(query: LicenseReviewQuery) {
    return licenseWorkbenchReviewList(
      this.workflow,
      this.configurationRevision,
      this.loadedOptions ?? this.options,
      query
    );
  }
  reviewDetail(id: string, query?: LicenseReviewQuery) {
    return licenseWorkbenchReviewDetail(
      this.workflow,
      this.configurationRevision,
      this.loadedOptions ?? this.options,
      id,
      query
    );
  }
  protected requireSelectedSourceLoaded() {
    if (this.sourceDraftPending)
      throw new Error(
        'Load the selected source or restore the loaded source settings before starting analysis'
      );
  }
  async selectRerun(body: LicenseRerunSelection) {
    const request = structuredClone(body);
    const fields = [
      request.configurationRevision,
      request.contentRevision,
      request.id,
      request.kind,
      request.confirmation,
      request.cancel,
      request.discardReviewedState,
    ];
    let operationId = request.operationId;
    if (!operationId) {
      // Older clients have no operation ID. Coalesce their latest identical request
      // until another selection or working revision supersedes its acknowledgement.
      const fingerprint = JSON.stringify(fields);
      const revision = this.workflow?.status.contentRevision;
      if (
        this.legacyRerun?.fingerprint !== fingerprint ||
        this.legacyRerun.revision !== revision ||
        request.configurationRevision !== this.configurationRevision
      )
        this.legacyRerun = { fingerprint, revision, operationId: randomUUID() };
      operationId = this.legacyRerun.operationId;
    } else if (!this.rerunOperations.get(operationId)) this.legacyRerun = undefined;
    if (this.operations.has(operationId))
      throw new Error('Operation ID was reused with different arguments');
    try {
      const result = await this.rerunOperations.run(operationId, 'prepare-free', fields, () =>
        this.reserve(() => this.configureRerun(request))
      );
      if (this.legacyRerun?.operationId === operationId)
        this.legacyRerun.revision = result.contentRevision;
      return structuredClone(result);
    } catch (error) {
      if (this.legacyRerun?.operationId === operationId) this.legacyRerun = undefined;
      throw error;
    }
  }
  private async configureRerun(body: LicenseRerunSelection) {
    if (this.practiceMode) throw new Error('Practice does not reassess saved evidence');
    this.requireSelectedSourceLoaded();
    if (this.activeOperationId || !this.workflow?.analyzed)
      throw new Error('Finish analysis before selecting a row reassessment');
    if (
      body.configurationRevision !== this.configurationRevision ||
      body.contentRevision !== this.workflow.status.contentRevision
    )
      throw new Error('Stale review revision');
    if (body.cancel) {
      this.workflow.cancelFreeSelection(body.contentRevision, body);
    } else await this.workflow.prepareFree(body.contentRevision, body);
    return this.visible;
  }
  configure(body: z.infer<typeof setupSchema>) {
    return this.reserve(() => this.configureSettings(body));
  }
  private async configureSettings(body: z.infer<typeof setupSchema>) {
    if (body.configurationRevision !== this.visible.configurationRevision)
      throw new Error('Configuration changed; reload setup before applying');
    if (this.activeOperationId) throw new Error('Cannot configure while an operation runs');
    if (
      body.discardReviewedState &&
      body.expectedContentRevision !== undefined &&
      body.expectedContentRevision !== (this.workflow?.status.contentRevision ?? 0)
    )
      throw new Error(
        'Discard confirmation is stale. Review the current content revision before replacing this source.'
      );
    if (this.practiceMode) {
      if (
        [
          body.databaseConnection,
          body.sourceDatabaseConnection,
          body.destinationDatabaseConnection,
        ].some((connection) => connection?.mode === 'session')
      )
        throw new Error('Practice cannot configure a database');
      if (
        this.workflow &&
        ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
          this.workflow.status.state
        )
      )
        throw new Error('Cannot configure while an operation runs');
      if (this.workflow?.status.state === 'uncertain')
        throw new Error('Save outcome uncertain; check the scratch Save target before continuing');
      if (
        body.source !== 'json' ||
        body.destination !== 'json' ||
        body.output !== this.visible.output ||
        body.force ||
        body.noCache ||
        body.cacheDir !== this.visible.cacheDir ||
        body.reportDir !== this.visible.reportDir ||
        body.reportFormats !== this.visible.reportFormats ||
        body.model !== this.visible.model ||
        body.sampleCount !== this.visible.sampleCount ||
        body.preserveExistingNonUnknowns
      )
        throw new Error('Practice setup only permits selecting a saved JSON input');
      const selected = body.input === 'Bundled example' ? null : body.input.trim();
      if (selected !== this.selectedPracticePath) this.sourceRevision++;
      this.selectedPracticePath = selected;
      this.discardRevision = body.discardReviewedState ? body.expectedContentRevision : undefined;
      this.configurationRevision++;
      return this.visible;
    }
    const options = applyLicenseWorkbenchOptions(this.options, body);
    const legacyRole = legacyDatabaseRole(options);
    const sourceDraft =
      body.sourceDatabaseConnection ??
      (legacyRole === 'source' ? body.databaseConnection : undefined);
    const source = sourceDraft
      ? selectWorkbenchDatabase(this.databaseConnection, sourceDraft)
      : this.databaseConnection;
    const destDraft =
      body.destinationDatabaseConnection ??
      (legacyRole === 'destination' ? body.databaseConnection : undefined);
    const destination = destDraft
      ? selectWorkbenchDatabase(this.destinationConnection, destDraft)
      : this.destinationConnection;
    const sourceConnectionChanged = !isDeepStrictEqual(source, this.databaseConnection);
    const destinationConnectionChanged = !isDeepStrictEqual(
      destination,
      this.destinationConnection
    );
    const sourceChanged =
      options.source !== this.options.source ||
      (options.source === 'json' && options.input !== this.options.input) ||
      sourceConnectionChanged;
    const aiChanged =
      options.model !== this.options.model ||
      options.sampleCount !== this.options.sampleCount ||
      options.cacheDir !== this.options.cacheDir ||
      options.noCache !== this.options.noCache;
    const destinationChanged =
      destinationConnectionChanged ||
      (
        [
          'output',
          'destination',
          'reportFormats',
          'reportDir',
          'force',
          'preserveExistingNonUnknowns',
        ] as const
      ).some((key) => this.options[key] !== options[key]);
    if (this.closed || this.workflow?.status.state === 'uncertain')
      throw new Error('Cannot configure this session');
    if (this.workflow && (destinationChanged || aiChanged)) {
      const loadedOptions = {
        ...options,
        source: this.loadedOptions?.source ?? options.source,
        input: this.loadedOptions?.input ?? options.input,
      };
      await this.workflow.configureLoadedSettings(loadedOptions, destinationChanged, aiChanged);
      if (this.loadedOptions) this.loadedOptions = loadedOptions;
    }
    this.configurationRevision++;
    this.options = options;
    this.discardRevision = body.discardReviewedState ? body.expectedContentRevision : undefined;
    this.reports.clear();
    if (sourceConnectionChanged) this.sourceConnectionRevision++;
    if (destinationConnectionChanged) this.destinationConnectionRevision++;
    if (sourceChanged) {
      this.sourceRevision++;
      this.databaseTests.appliedStatus = 'untested';
    }
    if (aiChanged) this.aiRevision++;
    if (destinationChanged) {
      this.destinationRevision++;
      this.destinationTests.appliedStatus = 'untested';
    }
    if (destDraft) this.destinationInitialized = true;
    this.destinationConnection = destination;
    this.databaseConnection = source;
    return this.visible;
  }
  async testDatabase(
    configurationRevision: number,
    draft?: z.infer<typeof setupSchema>['databaseConnection'],
    role?: 'source' | 'destination'
  ) {
    if (this.closed) throw new DatabaseTestUnavailableError('Session is closed');
    if (
      configurationRevision !==
      (role === 'destination'
        ? this.destinationRevision
        : role === 'source'
          ? this.sourceRevision
          : this.configurationRevision)
    )
      throw new DatabaseTestUnavailableError('Configuration changed; reload setup before testing');
    if (this.practiceMode)
      throw new DatabaseTestUnavailableError('Practice cannot test a database');
    if (this.activeOperationId)
      throw new DatabaseTestUnavailableError('Cannot test while an operation runs');
    if (this.workflow?.status.state === 'uncertain')
      throw new DatabaseTestUnavailableError(
        'Save outcome uncertain; check the actual Save targets before continuing'
      );
    const { connection: applied, tests } = this.databaseRole(role);
    const connection = draft ? selectWorkbenchDatabase(applied, draft) : applied;
    await tests.run(connection, Boolean(draft));
    return draft ? { tested: true } : this.visible;
  }
}
