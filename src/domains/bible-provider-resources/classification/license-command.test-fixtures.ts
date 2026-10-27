import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseSnapshot } from './license-database.types';

import { attestLicenseArtifact, serializeLicenseArtifact } from '../license-artifact';
import { makeLicenseArtifact, REVIEWER } from '../license-artifact.test-fixtures';
import { parseLicenseCommandOptions } from './license-command-options';

export async function makeCommandFixture(attested = true) {
  const dir = await mkdtemp(join(tmpdir(), 'license-command-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const artifact = attested
    ? attestLicenseArtifact(makeLicenseArtifact(), REVIEWER)
    : makeLicenseArtifact();
  const sourceBytes = serializeLicenseArtifact(artifact).bytes;
  await writeFile(input, sourceBytes);
  const parsed = parseLicenseCommandOptions(
    [
      '--source=json',
      '--destination=json',
      '--yes',
      '--report-formats=none',
      `--input=${input}`,
      `--output=${output}`,
      `--cache-dir=${join(dir, 'cache')}`,
    ],
    false
  );
  if (parsed.help) throw new Error('Unexpected help');
  const snapshot: LicenseDatabaseSnapshot = {
    tableExists: true,
    classifications: [],
    context: {
      label: 'Fixture target DB',
      projection: 'classification-only',
      resources: artifact.catalog.map((row) => ({ ...row, ttsLicenseStatus: 'allowed' })),
    },
  };
  const applied: LicenseArtifact[] = [];
  const adapter = {
    load: vi.fn(async () => structuredClone(snapshot)),
    apply: vi.fn(
      async (value: LicenseArtifact, _replace: boolean, publish?: () => Promise<void>) => {
        await publish?.();
        applied.push(structuredClone(value));
      }
    ),
    close: vi.fn(async () => {}),
  };
  const messages: string[] = [];
  const io = {
    write: (value: string) => {
      messages.push(value);
    },
    ask: vi.fn(async () => ''),
  };
  const dependencies = {
    apiKey: 'mock-key',
    interactive: false,
    io,
    database: vi.fn(async () => adapter),
    transport: vi.fn(async () => '{"rationale":"Permitted in this fixture.","decision":"allowed"}'),
  };
  return {
    dir,
    input,
    output,
    artifact,
    sourceBytes,
    options: parsed.options,
    snapshot,
    applied,
    adapter,
    messages,
    io,
    dependencies,
    readOutput: async () => JSON.parse(await readFile(output, 'utf8')) as LicenseArtifact,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
