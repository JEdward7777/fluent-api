import { describe, expect, it } from 'vitest';

import { demoBiblePatch } from './bibles';

function existingBible(
  overrides: Partial<Parameters<typeof demoBiblePatch>[0]> = {}
): Parameters<typeof demoBiblePatch>[0] {
  return { textResourceId: 1, audioResourceId: 7, ...overrides };
}

describe('demoBiblePatch (reseed of an adopted spec bible)', () => {
  it('leaves an operator-curated recording alone', () => {
    const bible = existingBible({ audioResourceId: 42 });

    expect(demoBiblePatch(bible, 1, 7)).toEqual({});
  });

  it('fills the audio slot while no recording is selected', () => {
    const bible = existingBible({ audioResourceId: null });

    expect(demoBiblePatch(bible, 1, 7)).toEqual({
      audioResourceId: 7,
    });
  });

  it('links the spec text resource onto a row without one', () => {
    const bible = existingBible({ textResourceId: null });

    expect(demoBiblePatch(bible, 2, undefined)).toEqual({
      textResourceId: 2,
    });
  });

  it('changes nothing when the spec omits externalId and audio', () => {
    const bible = existingBible({ textResourceId: null, audioResourceId: null });

    expect(demoBiblePatch(bible, undefined, undefined)).toEqual({});
  });
});
