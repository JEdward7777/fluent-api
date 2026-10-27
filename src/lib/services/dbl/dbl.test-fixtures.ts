import { vi } from 'vitest';

import { ok } from '@/lib/types';

import type { DblClient } from './dbl.client';
import type { DblBible } from './dbl.types';

export function makeDblTestClient(bibles: DblBible[] = []): DblClient {
  return {
    getBibles: vi.fn().mockResolvedValue(ok(bibles)),
    getBible: vi.fn(),
    getBooks: vi.fn(),
    getBook: vi.fn(),
    getChapters: vi.fn(),
    getChapter: vi.fn(),
    getVerses: vi.fn(),
    getVerse: vi.fn(),
    getPassage: vi.fn(),
    getAudioChapter: vi.fn(),
    getAudioBibleBooks: vi.fn(),
  };
}
