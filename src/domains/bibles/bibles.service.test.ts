import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { err, ErrorCode, ok } from '@/lib/types';
import { makeBible } from '@/test/utils/test-helpers';

import * as repo from './bibles.repository';
import {
  createBible,
  getAllBibles,
  getBibleById,
  getBiblesByLanguageId,
  updateBible,
} from './bibles.service';
import { createBibleSchema, updateBibleSchema } from './bibles.types';

vi.mock('./bibles.repository', () => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  getByLanguageId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/domains/bible-provider-resources/bible-provider-resources.service', () => ({
  getById: vi.fn(),
  getByProviderIdentity: vi.fn(),
  getByIds: vi.fn(),
  getByProviderIdentities: vi.fn(),
}));
const bible = makeBible({
  textResourceId: 8,
  externalId: 'text-id',
  audioResourceId: 3,
  updatedAt: new Date('2026-06-01T12:00:00.000Z'),
});
const text = {
  id: 8,
  provider: 'dbl' as const,
  externalId: 'text-id',
  ttsLicenseStatus: 'unknown' as const,
  licenseNotice: null,
  displayName: null,
};
const recording = { ...text, id: 3, provider: 'aquifer' as const, externalId: '1' };
const input = {
  name: bible.name,
  abbreviation: bible.abbreviation,
  languageId: 1,
  textResourceId: 8,
  audioResourceId: 3,
};
beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of [repo.getById, repo.create, repo.update])
    vi.mocked(fn).mockResolvedValue(ok(bible));
  for (const fn of [repo.getAll, repo.getByLanguageId])
    vi.mocked(fn).mockResolvedValue(ok([bible]));
  vi.mocked(resources.getById).mockImplementation(async (id) => ok(id === 8 ? text : recording));
  vi.mocked(resources.getByIds).mockImplementation(async (ids) =>
    ok([text, recording].filter((row) => ids.includes(row.id)))
  );
});

describe('canonical Bible responses', () => {
  it.each(['allowed', 'forbidden', 'unknown'] as const)(
    'uses text FK %s policy independently of recording',
    async (status) => {
      vi.mocked(resources.getById).mockImplementation(async (id) =>
        ok(id === 8 ? { ...text, ttsLicenseStatus: status } : recording)
      );
      const result = await getBibleById(1);
      expect(result).toMatchObject({
        ok: true,
        data: {
          ttsLicenseStatus: status,
          textBibleKey: 'dbl-text-id',
          selectedRecordingKey: 'aq-1',
          updatedAt: '2026-06-01T12:00:00.000Z',
        },
      });
      if (result.ok) {
        expect(result.data).not.toHaveProperty('textResourceId');
        expect(result.data).not.toHaveProperty('licenseNotice');
      }
      expect(resources.getByProviderIdentity).not.toHaveBeenCalled();
    }
  );
  it('preserves unlinked seed response without a text lookup', async () => {
    vi.mocked(repo.getById).mockResolvedValue(ok(makeBible({ externalId: null })));
    expect(await getBibleById(1)).toMatchObject({
      ok: true,
      data: {
        provider: 'dbl',
        hasAudio: false,
        textBibleKey: null,
        selectedRecordingKey: null,
        ttsLicenseStatus: 'unknown',
      },
    });
    expect(resources.getById).not.toHaveBeenCalled();
  });
  it('propagates text resource read failures', async () => {
    vi.mocked(resources.getById).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await getBibleById(1)).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });
  it.each([
    ['create', () => createBible(input)],
    ['update', () => updateBible(1, input)],
  ])('%s returns the unchanged public contract through FK lookups', async (_label, write) => {
    expect(await write()).toMatchObject({ ok: true, data: { id: 1, textBibleKey: 'dbl-text-id' } });
    expect(resources.getById).toHaveBeenCalledWith(8);
    expect(resources.getById).toHaveBeenCalledWith(3);
  });
  it.each([getAllBibles, () => getBiblesByLanguageId(1)])(
    'batch joins by resource IDs and retains order',
    async (read) => {
      const rows = [bible, { ...bible, id: 2 }, makeBible({ id: 3, externalId: null })];
      vi.mocked(repo.getAll).mockResolvedValue(ok(rows));
      vi.mocked(repo.getByLanguageId).mockResolvedValue(ok(rows));
      const result = await read();
      expect(result).toMatchObject({
        ok: true,
        data: [
          { id: 1, textBibleKey: 'dbl-text-id' },
          { id: 2, textBibleKey: 'dbl-text-id' },
          { id: 3, textBibleKey: null },
        ],
      });
      expect(resources.getByIds).toHaveBeenCalledWith([8]);
      expect(resources.getByIds).toHaveBeenCalledWith([3]);
      expect(resources.getByProviderIdentities).not.toHaveBeenCalled();
    }
  );
  it('propagates batch failures', async () => {
    vi.mocked(resources.getByIds).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await getAllBibles()).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });
});

describe('explicit SuperAdmin FK contract', () => {
  it.each(['provider', 'externalId', 'hasAudio'])(
    'rejects deprecated %s in both request schemas',
    (key) => {
      expect(
        createBibleSchema.safeParse({ ...input, [key]: key === 'hasAudio' ? true : 'dbl' }).success
      ).toBe(false);
      expect(
        updateBibleSchema.safeParse({ [key]: key === 'hasAudio' ? true : 'dbl' }).success
      ).toBe(false);
    }
  );
  it.each([0, -1, 1.5, '8'])('rejects invalid FK %s', (textResourceId) => {
    expect(createBibleSchema.safeParse({ ...input, textResourceId }).success).toBe(false);
  });
  it('allows explicit unlink and no-identity seeds', () => {
    expect(updateBibleSchema.parse({ textResourceId: null })).toEqual({ textResourceId: null });
    expect(
      createBibleSchema.safeParse({ name: 'Local', abbreviation: 'LOC', languageId: 1 }).success
    ).toBe(true);
  });
});
