import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LlmTransportError } from '@/lib/llm/structured-request';

import {
  checkLicenseArtifactReview,
  overrideLicenseClassification,
  serializeLicenseArtifact,
} from '../license-artifact';
import { runLicenseCommand } from './license-command';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseFileIo } from './license-write';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture(attested = true) {
  const value = await makeCommandFixture(attested);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

describe('license command source/destination and responsibility boundary', () => {
  it('exports JSON offline without opening a database or invoking inference, retaining exact unknown authority', async () => {
    const f = await fixture();
    expect(await runLicenseCommand(f.options, f.dependencies)).toBe(2);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    expect((await f.readOutput()).classifications).toEqual(f.artifact.classifications);
    expect(checkLicenseArtifactReview(await f.readOutput()).status).toBe('ready');
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    expect(f.messages.join('\n')).toContain('Production impact is unavailable');
  });
  it('validates the model credential before any file, catalog, report or database access', async () => {
    const f = await fixture();
    expect(
      await runLicenseCommand(
        { ...f.options, input: '/missing', destination: 'database' },
        { ...f.dependencies, apiKey: ' ' }
      )
    ).toBe(1);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.messages.join()).toContain('GOOGLE_AI_API_KEY');
  });
  it.each(['database', 'both'] as const)(
    'bootstraps an empty table from attested JSON to %s without requiring new reviewer flags',
    async (destination) => {
      const f = await fixture();
      expect(await runLicenseCommand({ ...f.options, destination }, f.dependencies)).toBe(2);
      expect(f.adapter.apply).toHaveBeenCalledOnce();
      expect(f.applied[0].reviewContentHash).toBe(f.artifact.reviewContentHash);
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      expect(f.io.ask).not.toHaveBeenCalled();
    }
  );
  it.each([{}, { force: true }])(
    'imports valid mixed state without signoff flags: %j',
    async (flags) => {
      const f = await fixture(false);
      expect(
        await runLicenseCommand({ ...f.options, destination: 'database', ...flags }, f.dependencies)
      ).toBe(2);
      expect(f.adapter.apply).toHaveBeenCalledOnce();
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    }
  );
  it.each([{ reviewer: 'Reviewer' }, { reviewReason: 'Checked' }])(
    'rejects bulk reviewer attribution: %j',
    async (flags) => {
      const f = await fixture(false);
      expect(
        await runLicenseCommand({ ...f.options, destination: 'database', ...flags }, f.dependencies)
      ).toBe(1);
      expect(f.messages.join()).toContain('named per-row human decision');
      expect(f.adapter.apply).not.toHaveBeenCalled();
    }
  );
  it('keeps a JSON source byte-for-byte unchanged on cross-only import', async () => {
    const f = await fixture(false);
    expect(await runLicenseCommand({ ...f.options, destination: 'database' }, f.dependencies)).toBe(
      2
    );
    expect(f.applied[0].classifications.map((row) => row.status)).toEqual(
      f.artifact.classifications.map((row) => row.status)
    );
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
  });
  it('imports an unknown row without inventing a note or reviewer', async () => {
    const f = await fixture(false);
    const value = structuredClone(f.artifact);
    delete value.classifications.find((row) => row.status === 'unknown')!.rowNote;
    await writeFile(f.input, serializeLicenseArtifact(value).bytes);
    expect(await runLicenseCommand({ ...f.options, destination: 'both' }, f.dependencies)).toBe(2);
    expect(
      f.applied[0].classifications.find((row) => row.status === 'unknown')?.rowNote
    ).toBeUndefined();
    expect(f.applied[0].classifications.every((row) => row.reviewedBy === null)).toBe(true);
  });
  it('syncs JSON into a nonempty DB without force and retains omitted rows', async () => {
    const f = await fixture();
    f.snapshot.classifications = [
      {
        normalizedText: 'absent key',
        status: 'forbidden',
        rationale: 'Prior',
        classifiedBy: 'manual',
        reviewedAt: null,
      },
    ];
    expect(await runLicenseCommand({ ...f.options, destination: 'database' }, f.dependencies)).toBe(
      2
    );
    expect(f.applied[0].classifications).toHaveLength(f.artifact.classifications.length);
    expect(f.messages.join()).not.toContain('delete 1');
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
  });
  it.each([
    { planOnly: true, yes: true },
    { planOnly: false, yes: false },
  ])('emits JSON preview without publishing DB policy with %j', async (flags) => {
    const f = await fixture();
    expect(
      await runLicenseCommand({ ...f.options, destination: 'both', ...flags }, f.dependencies)
    ).toBe(2);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect((await f.readOutput()).classifications).toEqual(f.artifact.classifications);
    expect(f.io.ask).not.toHaveBeenCalled();
  });
  it('fails a database destination with an absent table before inference or reports', async () => {
    const f = await fixture();
    f.snapshot.tableExists = false;
    expect(await runLicenseCommand({ ...f.options, destination: 'database' }, f.dependencies)).toBe(
      1
    );
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });
  it('assesses and saves an empty database source without whole-file bootstrap', async () => {
    const f = await fixture();
    expect(
      await runLicenseCommand(
        { ...f.options, source: 'database', destination: 'database', force: true },
        f.dependencies
      )
    ).toBe(0);
    expect(f.adapter.apply).toHaveBeenCalledOnce();
  });
  it.each(['database', 'both'] as const)(
    'returns an operational read failure before reading an inaccessible output path for %s',
    async (destination) => {
      const f = await fixture();
      const read = vi.fn(async () => {
        throw new Error('EISDIR: output is a directory');
      });
      const exit = await runLicenseCommand(
        { ...f.options, source: 'database', destination, output: f.dir },
        { ...f.dependencies, fs: { ...licenseFileIo, read } }
      );
      expect(exit).toBe(1);
      expect(f.messages.join('\n')).toContain('EISDIR');
      expect(read).toHaveBeenCalled();
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      expect(f.adapter.close).toHaveBeenCalledOnce();
    }
  );
  it('treats corrupt/evidence-invalid artifacts as operational failures with no writes', async () => {
    const f = await fixture();
    await writeFile(f.input, '{"broken":true}');
    expect(await runLicenseCommand({ ...f.options, destination: 'database' }, f.dependencies)).toBe(
      1
    );
    expect(f.adapter.apply).not.toHaveBeenCalled();
  });
  it('repairs a stale owned hash to incomplete during valid import', async () => {
    const f = await fixture();
    const value = structuredClone(f.artifact);
    value.catalog[0].name += ' changed';
    await writeFile(f.input, JSON.stringify(value));
    expect(await runLicenseCommand({ ...f.options, destination: 'database' }, f.dependencies)).toBe(
      2
    );
    expect(f.adapter.apply).toHaveBeenCalledOnce();
  });
  it('uses the current target notice in import reports and does not propose catalog inserts or metadata writes', async () => {
    const f = await fixture();
    f.snapshot.context.resources[0].rawNotice = 'New target terms absent from reviewed snapshot';
    f.snapshot.context.resources[0].bibleId = 999;
    f.snapshot.context.resources[0].name = 'Actual target Bible';
    expect(
      await runLicenseCommand(
        { ...f.options, destination: 'database', reportFormats: 'markdown', reportDir: f.dir },
        f.dependencies
      )
    ).toBe(2);
    const report = await readFile(`${f.dir}/license-impact.md`, 'utf8');
    expect(report).toContain('Classification-only import changes no Bible metadata or notices');
    expect(report).toContain('New target terms absent from reviewed snapshot');
    expect(f.messages.join()).toContain('new catalog records: 0');
    expect(f.messages.join()).toContain('missing exact classifications: 1');
  });
  it('exports a pre-table database to incomplete JSON without DB writes, and retains automatic technical provenance', async () => {
    const f = await fixture();
    f.snapshot.tableExists = false;
    expect(await runLicenseCommand({ ...f.options, source: 'database' }, f.dependencies)).toBe(0);
    const output = await f.readOutput();
    expect(output.reviewState).toBe('incomplete');
    expect(output.attestation).toBeUndefined();
    expect(output.classifications.some((row) => row.source === 'gemini')).toBe(true);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(f.dependencies.transport).toHaveBeenCalledTimes(6);
    expect(f.messages.join('\n')).toContain('Database remains unchanged');
    expect(f.messages.join('\n')).toContain('JSON sync:');
  });
  it.each(['database', 'both'] as const)(
    'permits initialized database-sourced yes maintenance to %s with authoritative unknown and no invented human notes',
    async (destination) => {
      const f = await fixture();
      f.snapshot.classifications = f.artifact.classifications.map((row) => ({
        normalizedText: row.normalizedText,
        status: row.status,
        rationale: row.rationale,
        classifiedBy: row.source,
        reviewedAt: null,
      }));
      expect(
        await runLicenseCommand({ ...f.options, source: 'database', destination }, f.dependencies)
      ).toBe(2);
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      expect(
        f.applied[0].classifications.find((row) => row.status === 'unknown')
      ).not.toHaveProperty('rowNote');
      expect(f.applied[0].attestation).toBeUndefined();
      if (destination === 'both') expect((await f.readOutput()).reviewState).toBe('incomplete');
    }
  );
  it('reports a DB-to-JSON conflict for undated changed decision without overwriting output', async () => {
    const f = await fixture();
    const base = structuredClone(f.artifact);
    base.extension = { top: true };
    base.classifications[1].extension = { row: true };
    await writeFile(f.output, JSON.stringify(base));
    f.snapshot.classifications = base.classifications.map((row) => ({
      normalizedText: row.normalizedText,
      status: row.status,
      rationale: row.rationale,
      classifiedBy: row.source,
      reviewedAt: null,
    }));
    f.snapshot.classifications[1].status = 'forbidden';
    f.snapshot.classifications[1].rationale = 'Changed table decision';
    expect(await runLicenseCommand({ ...f.options, source: 'database' }, f.dependencies)).toBe(3);
    expect(f.messages.join()).toContain('Save conflicts');
    const output = await f.readOutput();
    expect(output.extension).toEqual({ top: true });
    expect(output.classifications[1].status).toBe(base.classifications[1].status);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });
  it('quits interactive review without touching source bytes or DB and never accepts a default final confirmation', async () => {
    const f = await fixture();
    f.io.ask.mockResolvedValueOnce('W').mockResolvedValueOnce('').mockResolvedValueOnce('Q');
    expect(
      await runLicenseCommand(
        { ...f.options, destination: 'database', yes: false },
        { ...f.dependencies, interactive: true }
      )
    ).toBe(2);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
  });
  it.each([
    { planOnly: true, yes: true },
    { planOnly: false, yes: false },
  ])('allows validated incomplete JSON-to-DB previews: %j', async (flags) => {
    const f = await fixture(false);
    expect(
      await runLicenseCommand({ ...f.options, destination: 'database', ...flags }, f.dependencies)
    ).toBe(2);
    expect(f.adapter.apply).toHaveBeenCalledTimes(flags.yes && !flags.planOnly ? 1 : 0);
  });

  it('reports an undated same-rank provenance conflict without DB writes', async () => {
    const f = await fixture();
    f.snapshot.classifications = f.artifact.classifications.map((row) => ({
      normalizedText: row.normalizedText,
      status: row.status,
      rationale: row.rationale,
      classifiedBy: 'old producer',
      reviewedAt: null,
    }));
    expect(
      await runLicenseCommand(
        {
          ...f.options,
          destination: 'database',
          force: true,
          reportFormats: 'markdown,html',
          reportDir: f.dir,
        },
        f.dependencies
      )
    ).toBe(3);
    expect(f.messages.join()).toContain('Save conflicts');
    expect(f.adapter.apply).not.toHaveBeenCalled();
  });
  it('aborts without an applicable artifact or DB writes when a provider sample cannot complete', async () => {
    const f = await fixture();
    f.dependencies.transport.mockRejectedValue(new LlmTransportError(false, 401));
    expect(
      await runLicenseCommand(
        { ...f.options, source: 'database', destination: 'json' },
        f.dependencies
      )
    ).toBe(1);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(await licenseFileIo.read(f.output)).toBeNull();
  });
  it('does not apply anything when report output fails before review/write', async () => {
    const f = await fixture();
    expect(
      await runLicenseCommand(
        { ...f.options, destination: 'both', reportFormats: 'markdown', reportDir: f.dir },
        {
          ...f.dependencies,
          fs: {
            ...licenseFileIo,
            write: async () => {
              throw new Error('Report disk failure');
            },
          },
        }
      )
    ).toBe(1);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
  });

  it('writes an interactive mixed-state JSON output and independent DB payload without inference', async () => {
    const f = await fixture(false);
    f.io.ask
      .mockResolvedValueOnce('W')
      .mockResolvedValueOnce('yes')
      .mockResolvedValueOnce('Explicit reviewer')
      .mockResolvedValueOnce('Spot checked this revision')
      .mockResolvedValueOnce('yes');
    const reads: string[] = [];
    const debugExit = await runLicenseCommand(
      {
        ...f.options,
        destination: 'both',
        yes: false,
        reportFormats: 'markdown,html',
        reportDir: f.dir,
      },
      {
        ...f.dependencies,
        interactive: true,
        fs: {
          ...licenseFileIo,
          read: async (path) => {
            reads.push(path);
            return licenseFileIo.read(path);
          },
        },
      }
    );
    expect(debugExit).toBe(2);
    const output = await f.readOutput();
    expect(checkLicenseArtifactReview(output).status).toBe('review-required');
    expect(output.attestation).toBeUndefined();
    expect(f.applied[0].classifications.map((row) => row.status)).toEqual(
      output.classifications.map((row) => row.status)
    );
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    expect(reads.filter((path) => path === f.input).length).toBeGreaterThan(0);
    for (const extension of ['md', 'html']) {
      const report = await readFile(`${f.dir}/license-impact.${extension}`, 'utf8');
      expect(report).toContain('Classification decisions');
    }
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });
  it('records a named same-status human decision in interactive review', async () => {
    const f = await fixture(false);
    const key = f.artifact.classifications[0].normalizedText;
    f.artifact = overrideLicenseClassification(
      f.artifact,
      key,
      'forbidden',
      'Original human rationale.'
    ).artifact;
    f.sourceBytes = serializeLicenseArtifact(f.artifact).bytes;
    await writeFile(f.input, f.sourceBytes);
    f.io.ask
      .mockResolvedValueOnce('R')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('forbidden')
      .mockResolvedValueOnce('Different human rationale.')
      .mockResolvedValueOnce('Explicit reviewer')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('W')
      .mockResolvedValueOnce('yes');
    expect(
      await runLicenseCommand(
        { ...f.options, yes: false },
        { ...f.dependencies, interactive: true }
      )
    ).toBe(2);
    expect(f.messages.at(-1)).toContain('Wrote decisions');
    const output = await f.readOutput();
    expect(checkLicenseArtifactReview(output).status).toBe('review-required');
    expect(output.classifications[0]).toMatchObject({
      status: 'forbidden',
      reviewState: 'human_reviewed',
      reviewedBy: 'Explicit reviewer',
      rationale: 'Different human rationale.',
    });
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });
  it('rejects bulk reattestation flags and leaves an attested source untouched', async () => {
    const f = await fixture();
    expect(
      await runLicenseCommand(
        {
          ...f.options,
          destination: 'database',
          reviewer: 'New explicit reviewer',
          reviewReason: 'A second review of this exact revision',
        },
        f.dependencies
      )
    ).toBe(1);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
  });
});
