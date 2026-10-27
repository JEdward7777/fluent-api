import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import * as books from '@/domains/books/sync/dbl-book-sync';
import * as languages from '@/domains/languages/sync/dbl-language-sync';
import { makeDblTestClient } from '@/lib/services/dbl/dbl.test-fixtures';
import { err, ErrorCode, ok } from '@/lib/types';

import * as bibles from './dbl-bible-sync';
import { syncDblCatalog, syncDblCatalogLicensePhaseOne } from './dbl-catalog-sync';

vi.mock('@/domains/bible-provider-resources/bible-provider-resources.service', () => ({
  applyAllRightsReservedSweep: vi.fn(),
}));
vi.mock('@/domains/books/sync/dbl-book-sync', () => ({
  syncBooksFromDbl: vi.fn(),
  syncAudioAvailability: vi.fn(),
}));
vi.mock('@/domains/languages/sync/dbl-language-sync', () => ({ syncLanguagesFromDbl: vi.fn() }));
vi.mock('./dbl-bible-sync', () => ({ syncBiblesFromDbl: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(languages.syncLanguagesFromDbl).mockResolvedValue(
    ok({ totalBibles: 0, uniqueLanguages: 0, skippedInvalid: 0, inserted: 0, updated: 0 })
  );
  vi.mocked(bibles.syncBiblesFromDbl).mockResolvedValue(
    ok({
      totalBibles: 0,
      skippedMissingLanguage: 0,
      inserted: 0,
      updated: 0,
      licenseFacts: { inserted: 0, updated: 0, distinctNotices: 0, nullNotices: 0 },
    })
  );
  vi.mocked(books.syncBooksFromDbl).mockResolvedValue(
    ok({ totalBiblesProcessed: 0, totalBooksLinked: 0, errorCount: 0, partialFailure: false })
  );
  vi.mocked(books.syncAudioAvailability).mockResolvedValue(
    ok({ totalBiblesProcessed: 0, totalBooksUpdated: 0, errorCount: 0, partialFailure: false })
  );
  vi.mocked(resources.applyAllRightsReservedSweep).mockResolvedValue(
    ok({ matched: 1, updated: 1, unmatchedDistinctNotices: 1, unmatchedNotices: ['Autre notice'] })
  );
});

describe('explicit transitional license sync command boundary', () => {
  it('keeps ordinary sync non-optimistic and never runs the ARR sweep implicitly', async () => {
    const client = makeDblTestClient();
    expect((await syncDblCatalog(client)).ok).toBe(true);
    expect(bibles.syncBiblesFromDbl).toHaveBeenCalledWith(client, 'unknown');
    expect(resources.applyAllRightsReservedSweep).not.toHaveBeenCalled();
  });
  it('inserts allowed only on the named Phase-1 path and performs the English sweep last', async () => {
    const client = makeDblTestClient();
    expect(await syncDblCatalogLicensePhaseOne(client)).toMatchObject({
      ok: true,
      data: { sweep: { matched: 1, updated: 1, unmatchedDistinctNotices: 1 } },
    });
    expect(bibles.syncBiblesFromDbl).toHaveBeenCalledWith(client, 'allowed');
    const order = [
      languages.syncLanguagesFromDbl,
      bibles.syncBiblesFromDbl,
      books.syncBooksFromDbl,
      books.syncAudioAvailability,
      resources.applyAllRightsReservedSweep,
    ].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('still sweeps last after partial catalog failure and reports failure instead of success', async () => {
    vi.mocked(books.syncBooksFromDbl).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await syncDblCatalogLicensePhaseOne(makeDblTestClient())).toEqual(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(books.syncAudioAvailability).not.toHaveBeenCalled();
    expect(resources.applyAllRightsReservedSweep).toHaveBeenCalledOnce();
  });
  it('reports sweep failures and performs the last safety step after unexpected upstream errors', async () => {
    vi.mocked(languages.syncLanguagesFromDbl).mockRejectedValue(
      new Error('Unexpected provider failure')
    );
    vi.mocked(resources.applyAllRightsReservedSweep).mockResolvedValue(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(await syncDblCatalogLicensePhaseOne(makeDblTestClient())).toEqual(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(resources.applyAllRightsReservedSweep).toHaveBeenCalledOnce();
  });
});
