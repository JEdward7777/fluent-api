import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import {
  canonicalResources as bible_provider_resources,
  canonicalBibles as bibles,
} from '@/db/canonical-schema';
import { config as localConfig } from '@/db/env-configs/local';
import { IRV_BIBLE } from '@/db/seeds/reference-bibles';

import { seedDemoSpec } from './index';

let irv: { id: number; hasAudio: boolean; audioResourceId: number | null };

beforeAll(async () => {
  const [bible] = await db
    .select({
      id: bibles.id,
      hasAudio: bible_provider_resources.hasAudio,
      audioResourceId: bibles.audioResourceId,
    })
    .from(bibles)
    .innerJoin(bible_provider_resources, eq(bibles.textResourceId, bible_provider_resources.id))
    .where(
      and(
        eq(bible_provider_resources.provider, 'dbl'),
        eq(bible_provider_resources.externalId, IRV_BIBLE.externalId)
      )
    );
  if (!bible) throw new Error('Run local db:setup before DB tests');
  irv = bible;
});

describe('seedDemoSpec on the local spec (real database)', () => {
  it('preserves a curated recording and operator license state across a reseed', async () => {
    if (!localConfig.demoSpec) throw new Error('local config must declare a demoSpec');
    const [text] = await db
      .select()
      .from(bible_provider_resources)
      .where(
        and(
          eq(bible_provider_resources.provider, 'dbl'),
          eq(bible_provider_resources.externalId, IRV_BIBLE.externalId)
        )
      );
    const [audio] = await db
      .select()
      .from(bible_provider_resources)
      .where(
        and(
          eq(bible_provider_resources.provider, 'dbl'),
          eq(bible_provider_resources.externalId, IRV_BIBLE.audioExternalId)
        )
      );
    const [alternate] = await db
      .insert(bible_provider_resources)
      .values({
        provider: 'dbl',
        externalId: `test-audio-${randomUUID()}`,
        ttsLicenseStatus: 'allowed',
      })
      .returning();
    try {
      // Operator actions a reseed must not undo: pick a different recording,
      // turn audio off, block the TTS license, rename the audio resource.
      await db.update(bibles).set({ audioResourceId: alternate.id }).where(eq(bibles.id, irv.id));
      await db
        .update(bible_provider_resources)
        .set({ hasAudio: false })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: 'forbidden', licenseNotice: 'operator note' })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ displayName: 'renamed by operator' })
        .where(eq(bible_provider_resources.id, audio.id));

      await seedDemoSpec(localConfig.demoSpec);

      const [after] = await db.select().from(bibles).where(eq(bibles.id, irv.id));
      expect(after.audioResourceId).toBe(alternate.id);
      const [afterText] = await db
        .select()
        .from(bible_provider_resources)
        .where(eq(bible_provider_resources.id, text.id));
      expect(afterText.ttsLicenseStatus).toBe('forbidden');
      expect(afterText.hasAudio).toBe(false);
      expect(afterText.licenseNotice).toBe('operator note');
      const [afterAudio] = await db
        .select()
        .from(bible_provider_resources)
        .where(eq(bible_provider_resources.id, audio.id));
      expect(afterAudio.displayName).toBe('renamed by operator');
    } finally {
      await db
        .update(bibles)
        .set({ audioResourceId: irv.audioResourceId })
        .where(eq(bibles.id, irv.id));
      await db
        .update(bible_provider_resources)
        .set({
          ttsLicenseStatus: text.ttsLicenseStatus,
          licenseNotice: text.licenseNotice,
          hasAudio: irv.hasAudio,
        })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ displayName: audio.displayName })
        .where(eq(bible_provider_resources.id, audio.id));
      await db
        .delete(bible_provider_resources)
        .where(eq(bible_provider_resources.id, alternate.id));
    }
  });
});
