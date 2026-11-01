import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LicenseCommandOptions } from './license-command-options';

import {
  checkLicenseArtifactReview,
  createLicenseArtifact,
  serializeLicenseArtifact,
} from '../license-artifact';
import { LicenseWorkflow } from './license-workflow';

export interface LicensePractice {
  workflow: LicenseWorkflow;
  scratch: string;
  originalHash: string;
  selectedSource: string;
  options: LicenseCommandOptions;
}
export interface LicensePracticeCapability {
  input: string;
  output: string;
  cacheDir: string;
  reportDir: string;
}

const issuedCapabilities = new WeakSet<object>();

/** A structural lookalike cannot authorize bypassing the mandatory credential gate. */
export function isIssuedLicensePractice(value: unknown): value is LicensePracticeCapability {
  return typeof value === 'object' && value !== null && issuedCapabilities.has(value);
}

/** Allocate new private paths only after the operator explicitly inspects a source. */
export async function createLicensePractice(selectedPath: string | null): Promise<LicensePractice> {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'practice-example.json');
  const selectedSource = selectedPath ? resolve(selectedPath) : bundled;
  const originalBytes = await readFile(selectedSource, 'utf8');
  const checked = checkLicenseArtifactReview(JSON.parse(originalBytes));
  if (checked.status === 'invalid')
    throw new Error(`Practice source is invalid: ${checked.reason}`);
  const scratch = await mkdtemp(join(tmpdir(), 'fluent-license-practice-'));
  const original = join(scratch, 'original.json');
  const input = join(scratch, 'working-input.json');
  const output = join(scratch, 'output.json');
  const cacheDir = join(scratch, 'cache');
  const reportDir = join(scratch, 'reports');
  // No source path, symlink, or browser field can choose a practice write destination.
  await writeFile(original, originalBytes, { mode: 0o400, flag: 'wx' });
  await writeFile(input, serializeLicenseArtifact(createLicenseArtifact(checked.artifact)).bytes, {
    mode: 0o400,
    flag: 'wx',
  });
  await chmod(original, 0o400);
  await chmod(input, 0o400);
  const options: LicenseCommandOptions = {
    source: 'json',
    destination: 'json',
    input,
    output,
    cacheDir,
    reportDir,
    yes: false,
    planOnly: false,
    force: false,
    noCache: false,
    sampleCount: 3,
    model: 'google:gemini-3.8-flash',
    reportFormats: 'none',
    openReport: false,
    preserveExistingNonUnknowns: false,
  };
  const capability = Object.freeze({ input, output, cacheDir, reportDir });
  issuedCapabilities.add(capability);
  const workflow = new LicenseWorkflow(options, {
    apiKey: '',
    practice: capability,
  });
  return {
    workflow,
    scratch,
    selectedSource,
    originalHash: createHash('sha256').update(originalBytes).digest('hex'),
    options,
  };
}
