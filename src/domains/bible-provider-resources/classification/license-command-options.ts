import { parseArgs } from 'node:util';

import { LICENSE_CLASSIFICATIONS_PATH } from '../license-artifact.schemas';
import { selectLicenseReportFormats } from '../license-report-formats';

export const LICENSE_COMMAND_HELP = `Usage: npm run db:classify:licenses -- --source=json|database --destination=json|database|both
  --input=PATH --output=PATH (default: ${LICENSE_CLASSIFICATIONS_PATH})
  --yes Save the previewed destination decisions without prompts.
  --plan-only Produce plans/reports and JSON preview when selected; no database writes.
  --force Deprecated compatibility flag; does not change save behavior.
  --reviewer=NAME --review-reason=REASON Retired bulk flags; use a named per-row decision.
  Interactive review offers optional [A] whole-file assertion; it never promotes rows or gates Save.
  --no-cache --cache-dir=PATH --sample-count=INTEGER (>=2, default 3)
  --rerun-rule=KEY_SHA256 Repeat to reevaluate selected rows with current rules.
  --rerun-model=KEY_SHA256 Repeat to request a new assessment for selected rows.
  --model=google:<id> (overrides GOOGLE_AI_MODEL; default google:gemini-3.8-flash)
  --report-formats=markdown|html|markdown,html|none --report-dir=PATH --open-report
  --preserve-existing-non-unknowns Invocation only: preserve current resource policy in the preview;
    a later ordinary sync may overwrite it. This is not a durable permission override.
Uncached model requests require GOOGLE_AI_API_KEY. JSON-to-JSON needs no database, DBL, or model credentials.
Normal startup reads local .env for GOOGLE_AI_MODEL before browser setup; shell values take precedence.
Help and practice do not read .env. Browser source, database, cache, and provider work waits for Inspect/Analyze.
Source/destination are independent; JSON-to-database imports, database-to-JSON exports.
Valid mixed-state JSON may bootstrap an empty table. Cross-storage sync preserves destination winners.
Exit 0: complete/no unknown; 2: successful/unknown retained; 1: operational failure;
3: unresolved destination conflict, no database rows changed.
Noninteractive without --yes stops after plans/reports. --yes never opens a browser.`;

export interface LicenseCommandOptions {
  source?: 'json' | 'database';
  destination?: 'json' | 'database' | 'both';
  input: string;
  output: string;
  yes: boolean;
  planOnly: boolean;
  force: boolean;
  reviewer?: string;
  reviewReason?: string;
  noCache: boolean;
  cacheDir?: string;
  sampleCount: number;
  model: string;
  reportFormats: string;
  reportDir?: string;
  openReport: boolean;
  preserveExistingNonUnknowns: boolean;
  rerunRule?: string[];
  rerunModel?: string[];
}

export function parseLicenseCommandOptions(
  args: string[],
  interactive: boolean,
  environment: { GOOGLE_AI_MODEL?: string } = {}
) {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      destination: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      yes: { type: 'boolean' },
      'plan-only': { type: 'boolean' },
      force: { type: 'boolean' },
      reviewer: { type: 'string' },
      'review-reason': { type: 'string' },
      'no-cache': { type: 'boolean' },
      'cache-dir': { type: 'string' },
      'sample-count': { type: 'string' },
      model: { type: 'string', multiple: true },
      'report-formats': { type: 'string' },
      'report-dir': { type: 'string' },
      'open-report': { type: 'boolean' },
      'preserve-existing-non-unknowns': { type: 'boolean' },
      'rerun-rule': { type: 'string', multiple: true },
      'rerun-model': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true as const };
  if (values.source && !['json', 'database'].includes(values.source))
    throw new Error('Invalid source');
  if (values.destination && !['json', 'database', 'both'].includes(values.destination))
    throw new Error('Invalid destination');
  if ((!interactive || values.yes) && (!values.source || !values.destination))
    throw new Error('Select both --source and --destination');
  if (values.model && values.model.length !== 1)
    throw new Error('Repeated model adapters are not implemented');
  const configuredModel = environment.GOOGLE_AI_MODEL;
  const model =
    values.model?.[0] ??
    (configuredModel?.trim()
      ? configuredModel.startsWith('google:')
        ? configuredModel
        : `google:${configuredModel}`
      : 'google:gemini-3.8-flash');
  if (!/^google:[^\s:]+$/.test(model))
    throw new Error('Unsupported model prefix; use google:<model-id>');
  const sampleCount = Number(values['sample-count'] ?? 3);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 2)
    throw new Error('Sample count must be an integer of at least two');
  const options: LicenseCommandOptions = {
    source: values.source as LicenseCommandOptions['source'],
    destination: values.destination as LicenseCommandOptions['destination'],
    input: values.input ?? LICENSE_CLASSIFICATIONS_PATH,
    output: values.output ?? values.input ?? LICENSE_CLASSIFICATIONS_PATH,
    yes: values.yes ?? false,
    planOnly: values['plan-only'] ?? false,
    force: values.force ?? false,
    reviewer: values.reviewer,
    reviewReason: values['review-reason'],
    noCache: values['no-cache'] ?? false,
    cacheDir: values['cache-dir'],
    sampleCount,
    model,
    reportFormats: values['report-formats'] ?? 'markdown',
    reportDir: values['report-dir'],
    openReport: values['open-report'] ?? false,
    preserveExistingNonUnknowns: values['preserve-existing-non-unknowns'] ?? false,
    rerunRule: values['rerun-rule'] ?? [],
    rerunModel: values['rerun-model'] ?? [],
  };
  for (const digest of [...(options.rerunRule ?? []), ...(options.rerunModel ?? [])])
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error('Rerun keys must be lowercase SHA-256 digests of normalized license keys');
  for (const path of [options.input, options.output, options.cacheDir, options.reportDir])
    if (path !== undefined && !path.trim()) throw new Error('Paths must not be blank');
  selectLicenseReportFormats(options.reportFormats, {
    interactive,
    yes: options.yes,
    openReport: options.openReport,
  });
  return { help: false as const, options };
}
