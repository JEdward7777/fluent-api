import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeDblTestClient } from '@/lib/services/dbl/dbl.test-fixtures';
import { err, ErrorCode, ok } from '@/lib/types';
import { makeBible, makeDblBible, sampleLanguages } from '@/test/utils/test-helpers';

import { acquireDblBibleCatalog } from './dbl-bible-sync';

const { getBibles, getLanguages } = vi.hoisted(() => ({
  getBibles: vi.fn(),
  getLanguages: vi.fn(),
}));
vi.mock('../bibles.repository', () => ({ getAll: getBibles }));
vi.mock('@/domains/languages/languages.repository', () => ({ getAll: getLanguages }));

beforeEach(() => {
  vi.clearAllMocks();
  getBibles.mockResolvedValue(ok([]));
  getLanguages.mockResolvedValue(ok([{ ...sampleLanguages.english, id: 100 }]));
});

describe('read-only DBL full catalog acquisition', () => {
  it('propagates client failure before database reads', async () => {
    const client = makeDblTestClient();
    vi.mocked(client.getBibles).mockResolvedValue(err(ErrorCode.DBL_NOT_CONFIGURED));
    expect(await acquireDblBibleCatalog(client)).toEqual(err(ErrorCode.DBL_NOT_CONFIGURED));
    expect(getLanguages).not.toHaveBeenCalled();
    expect(getBibles).not.toHaveBeenCalled();
  });
  it.each(['language', 'Bible'])(
    'propagates %s catalog read failures without returning a partial plan',
    async (kind) => {
      (kind === 'language' ? getLanguages : getBibles).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );
      expect(await acquireDblBibleCatalog(makeDblTestClient())).toEqual(
        err(ErrorCode.INTERNAL_ERROR)
      );
    }
  );
  it('requests full details, trims copyright independently of recording attribution and preserves null notices', async () => {
    const client = makeDblTestClient([
      makeDblBible({
        id: 'b1',
        name: 'One',
        abbreviationLocal: 'ONE',
        copyright: '  Notice  ',
        info: 'promo',
      }),
      makeDblBible({ id: 'b2', name: 'Two', abbreviationLocal: 'TWO', copyright: ' \n ' }),
      makeDblBible({ id: 'b3', name: 'Three', abbreviationLocal: 'THREE', copyright: undefined }),
    ]);
    const result = await acquireDblBibleCatalog(client);
    expect(client.getBibles).toHaveBeenCalledWith({ includeFullDetails: true });
    expect(result).toMatchObject({
      ok: true,
      data: {
        totalBibles: 3,
        skippedMissingLanguage: 0,
        rows: [
          { externalId: 'b1', languageId: 100, textLicenseNotice: 'Notice' },
          { externalId: 'b2', textLicenseNotice: null },
          { externalId: 'b3', textLicenseNotice: null },
        ],
      },
    });
    if (result.ok)
      for (const row of result.data.rows) expect(row).not.toHaveProperty('licenseNotice');
  });
  it('omits resources and Bible plans for missing, invalid and unmapped languages', async () => {
    const base = makeDblBible();
    const client = makeDblTestClient([
      makeDblBible({ id: 'spa', language: { ...base.language, id: 'spa' } }),
      makeDblBible({ id: 'bad', language: { ...base.language, id: 'invalid' } }),
    ]);
    expect(await acquireDblBibleCatalog(client)).toMatchObject({
      ok: true,
      data: { totalBibles: 2, skippedMissingLanguage: 2, rows: [] },
    });
  });
  it('reuses the stored DBL name/abbreviation for resource display and ignores cross-provider identity collisions', async () => {
    getBibles.mockResolvedValue(
      ok([
        makeBible({ externalId: 'b1', name: 'Stored name', abbreviation: 'STORED' }),
        makeBible({
          id: 2,
          provider: 'aquifer',
          externalId: 'b2',
          name: 'Other provider',
          abbreviation: 'OTHER',
        }),
      ])
    );
    const result = await acquireDblBibleCatalog(
      makeDblTestClient([
        makeDblBible({ id: 'b1' }),
        makeDblBible({ id: 'b2', name: 'Incoming', abbreviationLocal: 'INC' }),
      ])
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        rows: [
          { name: 'Stored name', abbreviation: 'STORED' },
          { name: 'Incoming', abbreviation: 'INC' },
        ],
      },
    });
  });
  it('bounds abbreviation collision suffixes and maps advertised audio without changing recording identity', async () => {
    const client = makeDblTestClient([
      makeDblBible({
        id: 'bible-one',
        abbreviationLocal: 'A'.repeat(55),
        audioBibles: [{ id: 'ab1', name: 'Audio', nameLocal: 'Audio' }],
      }),
      makeDblBible({ id: 'bible-two', abbreviationLocal: 'A'.repeat(55), audioBibles: [] }),
    ]);
    const result = await acquireDblBibleCatalog(client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows[0].abbreviation).not.toBe(result.data.rows[1].abbreviation);
    for (const row of result.data.rows) {
      expect(row.abbreviation.length).toBeLessThanOrEqual(50);
      expect(row).not.toHaveProperty('audioResourceId');
    }
    expect(result.data.rows.map((row) => row.hasAudio)).toEqual([true, false]);
  });
});
