import { getTableColumns, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import { resourceProviderEnum, ttsLicenseStatusEnum } from './schema';

// Runtime tables deliberately exclude rollback-only columns. Drizzle inserts emit
// DEFAULT for every declared column, even when it is absent from values(). Keep
// migration generation on schema.ts; application SQL uses these canonical tables.
export const canonicalResources = pgTable('bible_provider_resources', {
  id: serial('id').primaryKey(),
  provider: resourceProviderEnum('provider').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  ttsLicenseStatus: ttsLicenseStatusEnum('tts_license_status').notNull().default('unknown'),
  licenseNotice: text('recording_license_notice'),
  textLicenseNotice: text('text_license_notice'),
  hasAudio: boolean('has_audio').notNull().default(false),
  displayName: text('display_name'),
});

export const canonicalBibles = pgTable('bibles', {
  id: serial('id').primaryKey(),
  languageId: integer('language_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  abbreviation: varchar('abbreviation', { length: 50 }).notNull(),
  textResourceId: integer('text_resource_id'),
  audioResourceId: integer('audio_resource_id'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .default(sql`next_catalogue_watermark()`)
    .$onUpdate(() => sql`next_catalogue_watermark()`),
});

export const bibleProjection = {
  ...getTableColumns(canonicalBibles),
  provider: sql<'dbl' | 'aquifer' | 'youversion'>`coalesce(${canonicalResources.provider}, 'dbl')`,
  externalId: canonicalResources.externalId,
  hasAudio: sql<boolean>`coalesce(${canonicalResources.hasAudio}, false)`,
};
