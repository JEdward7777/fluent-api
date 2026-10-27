import { describe, expect, it } from 'vitest';

import { normalizeLicenseNotice } from './license-normalizer';

describe('normalizeLicenseNotice', () => {
  it.each([
    [
      ' Copyright © (C) 2026   Example, Inc.\n All rights reserved! ',
      'example, inc. all rights reserved!',
    ],
    ['Copyright 1999-2026: Publisher (CC BY-NC-ND 4.0).', '-: publisher (cc by-nc-nd 4.0).'],
    ['  Édition publique — droits conservés. ', 'édition publique — droits conservés.'],
    [
      'copyrighted copyright-holder mycopyright 12345 code2026 123',
      'copyrighted -holder mycopyright 12345 code2026 123',
    ],
    ['© (c) Copyright 2026', ''],
    ['A. B/C; D: E! [F] (G)', 'a. b/c; d: e! [f] (g)'],
  ])('normalizes %j without stripping remaining punctuation or text', (notice, expected) => {
    expect(normalizeLicenseNotice(notice)).toBe(expected);
    expect(normalizeLicenseNotice(expected)).toBe(expected);
  });
});
