import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import {
  LicenseFileDriftError,
  licenseFileIo,
  LicenseWriteUncertainError,
  writeLicenseDestinations,
} from './license-write';

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
  it('rejects invalid UTF-8 before an exact byte baseline can be recorded', async () => {
    const f = await fixture();
    await writeFile(f.output, Buffer.from([255]));
    await expect(licenseFileIo.read(f.output)).rejects.toThrow('not valid UTF-8');
    await writeFile(f.output, Buffer.from([254]));
    await expect(licenseFileIo.read(f.output)).rejects.toThrow('not valid UTF-8');
    expect(await readFile(f.output)).toEqual(Buffer.from([254]));
  });
  it('rejects input and target drift before staging or database apply', async () => {
    const f = await fixture();
    await writeFile(f.input, 'external input');
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
        expectedFiles: [
          { path: f.input, bytes: f.sourceBytes },
          { path: f.output, bytes: null },
        ],
      })
    ).rejects.toThrow(LicenseFileDriftError);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    await writeFile(f.input, f.sourceBytes);
    await writeFile(f.output, 'new target');
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
        expectedFiles: [
          { path: f.input, bytes: f.sourceBytes },
          { path: f.output, bytes: null },
        ],
      })
    ).rejects.toThrow(LicenseFileDriftError);
    expect(await readFile(f.output, 'utf8')).toBe('new target');
    expect(f.adapter.apply).not.toHaveBeenCalled();
  });
  it('detects source deletion during staging and does not apply policy', async () => {
    const f = await fixture();
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
        expectedFiles: [
          { path: f.input, bytes: f.sourceBytes },
          { path: f.output, bytes: null },
        ],
        fs: {
          ...licenseFileIo,
          write: async (path, bytes) => {
            await licenseFileIo.write(path, bytes);
            await licenseFileIo.remove(f.input);
          },
        },
      })
    ).rejects.toThrow(LicenseFileDriftError);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(await licenseFileIo.read(f.output)).toBeNull();
  });
  it('rejects new target created during DB staging before replacement', async () => {
    const f = await fixture();
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await writeFile(f.output, 'external target');
      await publish?.();
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous: null }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: null }],
      })
    ).rejects.toThrow(LicenseFileDriftError);
    expect(await readFile(f.output, 'utf8')).toBe('external target');
  });
  it('rechecks a read-only JSON source at the database commit callback without output files', async () => {
    const f = await fixture();
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await writeFile(f.input, 'external input');
      await publish?.();
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.input, bytes: f.sourceBytes }],
      })
    ).rejects.toThrow(LicenseFileDriftError);
  });
  it('passes expected policy through and restores normal publication failures', async () => {
    const f = await fixture();
    const previous = 'old bytes';
    await writeFile(f.output, previous);
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit unknown');
    });
    await expect(
      writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: previous }],
        expectedPolicy: [],
      })
    ).rejects.toThrow('commit outcome may be uncertain');
    expect(await readFile(f.output, 'utf8')).toBe(previous);
    expect((f.adapter.apply.mock.calls[0] as unknown[])[4]).toEqual([]);
  });
  it('preserves an external edit after publication and retains recovery bytes', async () => {
    const f = await fixture();
    const previous = 'old bytes';
    await writeFile(f.output, previous);
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      await writeFile(f.output, 'external edit');
      throw new Error('commit unknown');
    });
    let errorMessage = '';
    let recovery: LicenseWriteUncertainError['recovery'] | undefined;
    try {
      await writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: previous }],
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof LicenseWriteUncertainError) recovery = error.recovery;
    }
    expect(errorMessage).toContain('DIVERGENCE');
    expect(await readFile(f.output, 'utf8')).toBe('external edit');
    const recoveryPaths = [...errorMessage.matchAll(/\S+\.recovery/g)].map((match) => match[0]);
    expect(recoveryPaths).toHaveLength(2);
    expect(recovery).toEqual({
      diverged: true,
      affectedPaths: [f.output],
      recoveryFiles: recoveryPaths,
      retainedTemporary: [],
      recoveryFailures: [],
    });
    expect(await Promise.all(recoveryPaths.map((path) => readFile(path, 'utf8')))).toEqual([
      previous,
      f.sourceBytes,
    ]);
  });
  it('keeps both recovery revisions if compensation cannot read the published target', async () => {
    const f = await fixture();
    const previous = 'old bytes';
    await writeFile(f.output, previous);
    let outputReads = 0;
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit unknown');
    });
    let message = '';
    try {
      await writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: previous }],
        fs: {
          ...licenseFileIo,
          read: async (path) => {
            if (path === f.output && ++outputReads === 5) throw new Error('read denied');
            return licenseFileIo.read(path);
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('DIVERGENCE');
    const recoveryPaths = [...message.matchAll(/\S+\.recovery/g)].map((match) => match[0]);
    expect(recoveryPaths).toHaveLength(2);
    expect(await Promise.all(recoveryPaths.map((path) => readFile(path, 'utf8')))).toEqual([
      previous,
      f.sourceBytes,
    ]);
  });
  it('reports the surviving prior-byte temporary file when restore and recovery copies fail', async () => {
    const f = await fixture();
    const previous = 'old bytes';
    await writeFile(f.output, previous);
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit unknown');
    });
    let renameCount = 0;
    let message = '';
    try {
      await writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: previous }],
        fs: {
          ...licenseFileIo,
          rename: async (from, to) => {
            if (++renameCount === 2) throw new Error('restore rename denied');
            await licenseFileIo.rename(from, to);
          },
          write: async (path, bytes) => {
            if (path.endsWith('.recovery')) throw new Error('recovery denied');
            await licenseFileIo.write(path, bytes);
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Recovery files: none written');
    const temporary = message.match(/(\/\S+\.tmp) \(prior bytes\)/)?.[1];
    expect(temporary).toBeDefined();
    expect(await readFile(temporary!, 'utf8')).toBe(previous);
    expect(await readFile(f.output, 'utf8')).toBe(f.sourceBytes);
  });
  it('does not delete an unreadable temporary file after failed restoration', async () => {
    const f = await fixture();
    const previous = 'old bytes';
    await writeFile(f.output, previous);
    f.adapter.apply.mockImplementation(async (_artifact, _replace, publish) => {
      await publish?.();
      throw new Error('commit unknown');
    });
    let renameCount = 0;
    let message = '';
    try {
      await writeLicenseDestinations({
        artifact: f.artifact,
        files: [{ path: f.output, previous }],
        database: f.adapter,
        replace: true,
        expectedFiles: [{ path: f.output, bytes: previous }],
        fs: {
          ...licenseFileIo,
          rename: async (from, to) => {
            if (++renameCount === 2) throw new Error('restore rename denied');
            await licenseFileIo.rename(from, to);
          },
          write: async (path, bytes) => {
            if (path.endsWith('.recovery')) throw new Error('recovery denied');
            await licenseFileIo.write(path, bytes);
          },
          read: async (path) => {
            if (path.endsWith('.tmp')) throw new Error('temporary read denied');
            return licenseFileIo.read(path);
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const temporary = message.match(/(\/\S+\.tmp) \(unverified; read failed\)/)?.[1];
    expect(temporary).toBeDefined();
    expect(await readFile(temporary!, 'utf8')).toBe(previous);
    expect(await readFile(f.output, 'utf8')).toBe(f.sourceBytes);
  });
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
