import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { makeBible } from '@/test/utils/test-helpers';

import { getChapterSourceAudio, matchAquiferBible } from './source-audio.service';

vi.mock('@/domains/bibles/bibles.repository', () => ({ getById: vi.fn() }));
vi.mock('@/domains/books/books.service', () => ({ getBookByCode: vi.fn() }));
vi.mock('@/domains/bibles/bible-audio/bible-audio.service', () => ({ getSourceAudio: vi.fn() }));
vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getBibles: vi.fn(),
  getBibleText: vi.fn(),
}));
vi.mock('./source-audio.repository', () => ({ isBibleBookLinkedToProject: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const fluentBible = makeBible();

describe('source audio provider routing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses the Aquifer identity instead of a sibling fuzzy match and never matches YouVersion', () => {
    const candidates = [
      { id: 10, name: fluentBible.name, abbreviation: fluentBible.abbreviation },
      { id: 11, name: 'Renamed edition', abbreviation: 'NEW' },
    ];
    expect(
      matchAquiferBible({ ...fluentBible, provider: 'aquifer', externalId: '11' }, candidates)?.id
    ).toBe(11);
    expect(
      matchAquiferBible({ ...fluentBible, provider: 'aquifer', externalId: '99' }, candidates)
    ).toBeUndefined();
    expect(
      matchAquiferBible({ ...fluentBible, provider: 'youversion' }, candidates)
    ).toBeUndefined();
  });

  it('rejects YouVersion before DBL or Aquifer calls', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...fluentBible, provider: 'youversion' }));
    expect(
      await getChapterSourceAudio({
        languageCode: 'eng',
        fluentBibleId: 1,
        bookCode: 'MRK',
        chapter: 14,
      })
    ).toEqual(err(ErrorCode.UNSUPPORTED_BIBLE_PROVIDER));
    expect(bibleAudioService.getSourceAudio).not.toHaveBeenCalled();
    expect(getBibles).not.toHaveBeenCalled();
    expect(getBibleText).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'aquifer', externalId: '11' },
    { provider: 'dbl', externalId: null },
  ] as const)('routes $provider/$externalId straight to Aquifer', async (identity) => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...fluentBible, ...identity }));
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });
    expect(result.ok).toBe(true);
    expect(bibleAudioService.getSourceAudio).not.toHaveBeenCalled();
    expect(getBibles).toHaveBeenCalledWith('eng');
  });
});
