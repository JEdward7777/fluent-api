// Literal release-2 physical tables for historical upgrade/rollback tests only.
// Current-schema fixtures import schema.ts and never install these bridges.
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { languages, resourceProviderEnum, ttsLicenseStatusEnum } from '../schema';

export * from '../schema';
export const bibleProviderEnum = pgEnum('bible_provider', ['dbl', 'aquifer', 'youversion']);
export const bible_provider_resources = pgTable(
  'bible_provider_resources',
  {
    id: serial('id').primaryKey(),
    provider: resourceProviderEnum('provider').notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    ttsLicenseStatus: ttsLicenseStatusEnum('tts_license_status').notNull().default('unknown'),
    legacyLicenseNotice: text('license_notice'),
    licenseNotice: text('recording_license_notice'),
    textLicenseNotice: text('text_license_notice'),
    hasAudio: boolean('has_audio').notNull().default(false),
    displayName: text('display_name'),
  },
  (table) => [
    uniqueIndex('idx_bible_provider_resources_identity').on(table.provider, table.externalId),
  ]
);
export const bibles = pgTable(
  'bibles',
  {
    id: serial('id').primaryKey(),
    languageId: integer('language_id')
      .notNull()
      .references(() => languages.id),
    name: varchar('name', { length: 255 }).notNull().unique(),
    abbreviation: varchar('abbreviation', { length: 50 }).notNull().unique(),
    provider: bibleProviderEnum('provider').notNull().default('dbl'),
    externalId: varchar('external_id', { length: 255 }),
    hasAudio: boolean('has_audio').notNull().default(false),
    textResourceId: integer('text_resource_id').references(() => bible_provider_resources.id, {
      onDelete: 'restrict',
    }),
    audioResourceId: integer('audio_resource_id').references(() => bible_provider_resources.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .default(sql`next_catalogue_watermark()`)
      .$onUpdate(() => sql`next_catalogue_watermark()`),
  },
  (table) => [
    uniqueIndex('idx_bibles_text_resource_id')
      .on(table.textResourceId)
      .where(sql`${table.textResourceId} IS NOT NULL`),
    uniqueIndex('idx_bibles_provider_external_id')
      .on(table.provider, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ]
);
