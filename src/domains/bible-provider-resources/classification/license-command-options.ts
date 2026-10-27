import { parseArgs } from 'node:util';

import { LICENSE_CLASSIFICATIONS_PATH } from '../license-artifact.schemas';
import { selectLicenseReportFormats } from '../license-report-formats';

export const LICENSE_COMMAND_HELP = `Usage: npm run db:classify:licenses -- --source=json|database --destination=json|database|both
  --input=PATH --output=PATH (default: ${LICENSE_CLASSIFICATIONS_PATH})
  --yes Accept automatic maintenance decisions without prompts (never implies --force).
  --plan-only Produce plans/reports without database writes.
  --force Replace the entire classification table from JSON, deleting absent keys.
  --reviewer=NAME --review-reason=REASON Attest the exact JSON revision with --yes.
  --no-cache --cache-dir=PATH --sample-count=INTEGER (>=2, default 3)
  --model=google:<id> (default google:gemini-3.8-flash; other/repeated adapters unsupported)
  --report-formats=markdown|html|markdown,html|none --report-dir=PATH --open-report
  --preserve-existing-non-unknowns Invocation only: preserve current resource policy in the preview;
    a later ordinary sync may overwrite it. This is not a durable permission override.
Requires GEMINI_API_KEY even without inference. JSON-to-JSON needs no database or DBL credentials.
Source/destination are independent; JSON-to-database imports, database-to-JSON exports.
An empty table bootstraps only from attested JSON. --force never bypasses review.
Exit 0: complete/no unknown; 2: successful/unknown retained; 1: operational failure;
3: review responsibility missing, no database rows changed.
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
}

export function parseLicenseCommandOptions(args: string[], interactive: boolean) {
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
  const model = values.model?.[0] ?? 'google:gemini-3.8-flash';
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
  };
  for (const path of [options.input, options.output, options.cacheDir, options.reportDir])
    if (path !== undefined && !path.trim()) throw new Error('Paths must not be blank');
  selectLicenseReportFormats(options.reportFormats, {
    interactive,
    yes: options.yes,
    openReport: options.openReport,
  });
  return { help: false as const, options };
}
