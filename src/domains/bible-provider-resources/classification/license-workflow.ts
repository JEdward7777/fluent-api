import { resolve } from 'node:path';

import type { LlmTransport } from '@/lib/llm/structured-request';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter, LicenseDatabaseSnapshot } from './license-database.types';
import type { LicenseFileIo } from './license-write';

import { checkLicenseArtifactReview } from '../license-artifact';
import { createLicenseClassifier } from '../license-classifier';
import { freezeLicenseRevision, freezeReviewValue } from '../license-review-revision';
import { analyzeDatabaseLicenses } from './license-analysis';
import { licenseFileIo } from './license-write';

type LicenseWorkflowState =
  | 'configuring'
  | 'reconfiguring'
  | 'inspecting'
  | 'inspected'
  | 'analyzing'
  | 'reviewing'
  | 'error'
  | 'closed';

interface LicenseInspection {
  configurationRevision: number;
  inspectedAt: string;
  inputBytes: string | null;
  outputBytes: string | null;
  database?: LicenseDatabaseSnapshot;
}

interface LicenseAnalysis {
  configurationRevision: number;
  contentRevision: number;
  artifact: LicenseArtifact;
  originalSourceArtifact?: LicenseArtifact;
}

interface LicenseWorkflowDependencies {
  apiKey: string;
  fs?: LicenseFileIo;
  database?: () => Promise<LicenseDatabaseAdapter>;
  transport?: LlmTransport;
  now?: () => string;
}

function parseArtifact(bytes: string): LicenseArtifact {
  const checked = checkLicenseArtifactReview(JSON.parse(bytes));
  if (checked.status === 'invalid') throw new Error(checked.reason);
  return checked.artifact;
}

export class LicenseBootstrapRequiredError extends Error {
  constructor() {
    super(
      'Review required: an empty classification table bootstraps only from attested JSON. Export database-to-JSON, review it, then import that JSON.'
    );
    this.name = 'LicenseBootstrapRequiredError';
  }
}

/** Invocation-owned operations. Browser freshness/preflight and publication gates are separate work. */
export class LicenseWorkflow {
  private options: LicenseCommandOptions;
  private dependencies: LicenseWorkflowDependencies;
  private database?: LicenseDatabaseAdapter;
  private inspection?: LicenseInspection;
  private analysis?: LicenseAnalysis;
  private configurationRevision = 1;
  private contentRevision = 0;
  private state: LicenseWorkflowState = 'configuring';
  private closing = false;
  private busyDone?: Promise<void>;
  private finishBusy?: () => void;
  private closePromise?: Promise<void>;

  constructor(options: LicenseCommandOptions, dependencies: LicenseWorkflowDependencies) {
    this.options = freezeReviewValue(options);
    this.dependencies = dependencies;
  }

  get status() {
    return freezeReviewValue({
      state: this.state,
      configurationRevision: this.configurationRevision,
      contentRevision: this.contentRevision,
    });
  }

  get inspected() {
    return this.inspection;
  }

  get analyzed() {
    return this.analysis;
  }

  get databaseAdapter() {
    return this.database;
  }

  async configure(options: LicenseCommandOptions, expectedRevision: number) {
    this.requireRevision(expectedRevision);
    if (this.state === 'inspecting' || this.state === 'analyzing' || this.state === 'reconfiguring')
      throw new Error(`Cannot configure while ${this.state}`);
    this.state = 'reconfiguring';
    this.beginBusy();
    try {
      await this.database?.close?.();
      this.database = undefined;
      this.options = freezeReviewValue(options);
      this.inspection = undefined;
      this.analysis = undefined;
      this.configurationRevision++;
      this.contentRevision = 0;
      this.state = 'configuring';
      return this.status;
    } catch (error) {
      this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  async inspect(expectedRevision: number): Promise<LicenseInspection> {
    this.requireRevision(expectedRevision);
    if (this.state !== 'configuring' && this.state !== 'error')
      throw new Error(`Cannot inspect while ${this.state}`);
    if (!this.dependencies.apiKey.trim())
      throw new Error('A nonempty GEMINI_API_KEY is required before reading any source');
    const options = this.options;
    if (!options.source || !options.destination)
      throw new Error('Select both source and destination before analysis');
    if (!/^google:[^\s:]+$/.test(options.model))
      throw new Error(`Unsupported model reference: ${options.model}. Use google:<model-id>`);
    if (!Number.isInteger(options.sampleCount) || options.sampleCount < 2)
      throw new Error('Sample count must be an integer of at least two');
    this.state = 'inspecting';
    this.beginBusy();
    try {
      const fs = this.dependencies.fs ?? licenseFileIo;
      const needsDatabase = options.source === 'database' || options.destination !== 'json';
      if (needsDatabase && !this.database)
        this.database = await (this.dependencies.database?.() ??
          import('./license-classifications.service').then((module) =>
            module.createLicenseDatabaseAdapter()
          ));
      const loaded = await this.database?.load();
      const snapshot = loaded ? freezeReviewValue(loaded) : undefined;
      if (options.destination !== 'json' && !snapshot?.tableExists)
        throw new Error(
          'The license_classifications table must exist before a database destination can be used'
        );
      if (
        options.source === 'database' &&
        options.destination !== 'json' &&
        !snapshot?.classifications.length
      )
        throw new LicenseBootstrapRequiredError();
      const inputBytes = options.source === 'json' ? await fs.read(options.input) : null;
      if (options.source === 'json' && inputBytes === null)
        throw new Error(`JSON source not found: ${options.input}`);
      const samePath = resolve(options.output) === resolve(options.input);
      const outputBytes =
        samePath && options.source === 'json' ? inputBytes : await fs.read(options.output);
      this.inspection = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        inspectedAt: this.dependencies.now?.() ?? new Date().toISOString(),
        inputBytes,
        outputBytes,
        ...(snapshot ? { database: snapshot } : {}),
      });
      this.state = 'inspected';
      return this.inspection;
    } catch (error) {
      this.inspection = undefined;
      this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  async startAnalysis(expectedRevision: number): Promise<LicenseAnalysis> {
    this.requireRevision(expectedRevision);
    if (this.state !== 'inspected' || !this.inspection)
      throw new Error('Inspect inputs before starting analysis');
    const inspection = this.inspection;
    const options = this.options;
    if (
      options.source === 'database' &&
      options.destination !== 'json' &&
      !inspection.database?.classifications.length
    )
      throw new LicenseBootstrapRequiredError();
    this.state = 'analyzing';
    this.beginBusy();
    try {
      const base =
        options.source === 'database' && inspection.outputBytes !== null
          ? parseArtifact(inspection.outputBytes)
          : undefined;
      const artifact =
        options.source === 'json'
          ? parseArtifact(inspection.inputBytes!)
          : await analyzeDatabaseLicenses({
              catalog: inspection.database!.context.resources.map(
                ({ ttsLicenseStatus: _status, ...row }) => row
              ),
              classifications: inspection.database!.classifications,
              base,
              classify: createLicenseClassifier({
                apiKey: this.dependencies.apiKey,
                model: options.model,
                sampleCount: options.sampleCount,
                cacheDir: options.cacheDir,
                noCache: options.noCache,
                transport: this.dependencies.transport,
              }),
              model: options.model,
              sampleCount: options.sampleCount,
            });
      const frozen = freezeLicenseRevision(artifact);
      this.analysis = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        contentRevision: ++this.contentRevision,
        artifact: frozen,
        ...(options.source === 'json' ? { originalSourceArtifact: frozen } : {}),
      });
      this.state = 'reviewing';
      return this.analysis;
    } catch (error) {
      this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.busyDone;
      this.state = 'closed';
      await this.database?.close?.();
      this.database = undefined;
    })();
    return this.closePromise;
  }

  private requireRevision(expectedRevision: number) {
    if (expectedRevision !== this.configurationRevision)
      throw new Error('Stale license workflow configuration revision');
    if (this.state === 'closed' || this.closing) throw new Error('License workflow is closed');
  }

  private beginBusy() {
    this.busyDone = new Promise<void>((resolve) => {
      this.finishBusy = resolve;
    });
  }

  private endBusy() {
    this.finishBusy?.();
    this.finishBusy = undefined;
    this.busyDone = undefined;
  }
}
