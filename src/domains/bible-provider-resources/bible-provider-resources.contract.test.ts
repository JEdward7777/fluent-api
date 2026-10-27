import { describe, expect, it } from 'vitest';

import { resourceProviderEnum } from '@/db/schema';
import { playbackProviderSchema } from '@/domains/playback-audio/playback-audio.types';
import { SOURCE_AUDIO_PROVIDERS } from '@/domains/source-audio/source-audio.types';

import {
  BIBLE_PROVIDER_PREFIXES,
  bibleKey,
  parseBibleKey,
} from './bible-provider-resources.identity';

describe('bible provider identity cross-layer contract', () => {
  it('keeps persistence, key prefixes, and playback validation in sync', () => {
    const persistedProviders = new Set(resourceProviderEnum.enumValues);

    expect(new Set(Object.keys(BIBLE_PROVIDER_PREFIXES))).toEqual(persistedProviders);
    expect(new Set(playbackProviderSchema.options)).toEqual(persistedProviders);
  });

  it('round-trips every persisted resource provider', () => {
    for (const provider of resourceProviderEnum.enumValues) {
      const identity = { provider, externalId: '1' };
      expect(parseBibleKey(bibleKey(identity))).toEqual(identity);
    }
  });

  it('keeps audio capabilities explicitly narrower than resource identities', () => {
    const persistedProviders = new Set(resourceProviderEnum.enumValues);

    expect(SOURCE_AUDIO_PROVIDERS.every((provider) => persistedProviders.has(provider))).toBe(true);
    expect(new Set(SOURCE_AUDIO_PROVIDERS).size).toBeLessThan(persistedProviders.size);
  });
});
