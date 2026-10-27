import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseFileIo, writeLicenseDestinations } from './license-write';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture() {
  const f = await makeCommandFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

describe('bounded file/database compensation', () => {
  it('stages JSON, stages DB, atomically publishes, then commits, preserving exact frozen bytes', async () => {
    const f = await fixture();
    const order: string[] = [];
    const fs = {
      ...licenseFileIo,
      write: vi.fn(async (path: string, bytes: string) => {
        order.push('stage file');
        await licenseFileIo.write(path, bytes);
      }),
      rename: vi.fn(async (a: string, b: string) => {
        order.push('publish file');
        await licenseFileIo.rename(a, b);
      }),
    };
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      order.push('stage DB');
      await publish?.();
      order.push('commit DB');
    });
    await writeLicenseDestinations({
      artifact: f.artifact,
      files: [{ path: f.output, previous: null }],
      database: f.adapter,
      replace: true,
      fs,
    });
    expect(order).toEqual(['stage file', 'stage DB', 'publish file', 'commit DB']);
    expect(await readFile(f.output, 'utf8')).toBe(f.sourceBytes);
  });
  it('restores exact prior bytes after commit failure, including original formatting', async () => {
    const f = await fixture();
    const previous = ' { "prior": true } ';
    await writeFile(f.output, previous);
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit failed');
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
      })
    ).rejects.toThrow('prior JSON restored');
    expect(await readFile(f.output, 'utf8')).toBe(previous);
    expect(f.applied).toEqual([]);
  });
  it('removes a newly published JSON if the database cannot commit', async () => {
    const f = await fixture();
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit failed');
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
      })
    ).rejects.toThrow('prior JSON restored');
    expect(await licenseFileIo.read(f.output)).toBeNull();
  });
  it('does not stage a database mutation when file preflight fails', async () => {
    const f = await fixture();
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
        fs: {
          ...licenseFileIo,
          write: async () => {
            throw new Error('disk full');
          },
        },
      })
    ).rejects.toThrow('disk full');
    expect(f.adapter.apply).not.toHaveBeenCalled();
  });
  it('throws from atomic replacement inside the transaction and retains all old files', async () => {
    const f = await fixture();
    await writeFile(f.output, 'prior output');
    const fs = {
      ...licenseFileIo,
      rename: async (from: string, to: string) => {
        if (to === f.output) throw new Error('rename denied');
        await licenseFileIo.rename(from, to);
      },
    };
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [
          { path: f.input, previous: f.sourceBytes },
          { path: f.output, previous: 'prior output' },
        ],
        database: f.adapter,
        replace: true,
        fs,
      })
    ).rejects.toThrow('rename denied');
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    expect(await readFile(f.output, 'utf8')).toBe('prior output');
    expect(f.applied).toEqual([]);
  });
  it('reports exact divergence and recovery when compensation also fails', async () => {
    const f = await fixture();
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('PG commit');
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: 'prior' }],
        database: f.adapter,
        replace: true,
        fs: {
          ...licenseFileIo,
          write: vi
            .fn()
            .mockImplementationOnce(licenseFileIo.write)
            .mockRejectedValue(new Error('restore failed')),
        },
      })
    ).rejects.toThrow(`DIVERGENCE: unable to restore ${f.output}`);
    expect(await readFile(f.output, 'utf8')).toBe(f.sourceBytes);
  });
});
