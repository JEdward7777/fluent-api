import { and, eq, gte, ilike, or, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bibleProjection,
  canonicalBibles as bibles,
  canonicalResources,
} from '@/db/canonical-schema';
import { languages } from '@/db/schema';
import { runInTransaction } from '@/db/transaction';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Bible, CreateBible, SourceSearchResponse, UpdateBible } from './bibles.types';

export async function getAll(updatedAfter?: Date): Promise<Result<Bible[]>> {
  try {
    const rows = updatedAfter
      ? await db
          .select(bibleProjection)
          .from(bibles)
          .leftJoin(canonicalResources, eq(bibles.textResourceId, canonicalResources.id))
          .where(gte(bibles.updatedAt, updatedAfter))
      : await db
          .select(bibleProjection)
          .from(bibles)
          .leftJoin(canonicalResources, eq(bibles.textResourceId, canonicalResources.id));
    return ok(rows);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get all bibles' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number, tx?: DbTransaction): Promise<Result<Bible>> {
  try {
    const [bible] = await (tx ?? db)
      .select(bibleProjection)
      .from(bibles)
      .leftJoin(canonicalResources, eq(bibles.textResourceId, canonicalResources.id))
      .where(eq(bibles.id, id))
      .limit(1);
    if (!bible) return err(ErrorCode.BIBLE_NOT_FOUND);
    return ok(bible);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get bible by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByLanguageId(languageId: number): Promise<Result<Bible[]>> {
  try {
    return ok(
      await db
        .select(bibleProjection)
        .from(bibles)
        .leftJoin(canonicalResources, eq(bibles.textResourceId, canonicalResources.id))
        .where(eq(bibles.languageId, languageId))
    );
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bibles by language ID',
      context: { languageId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function create(data: CreateBible): Promise<Result<Bible>> {
  try {
    return await runInTransaction(async (tx) => {
      const [written] = await tx.insert(bibles).values(data).returning({ id: bibles.id });
      if (!written) return err(ErrorCode.INTERNAL_ERROR);
      return getById(written.id, tx);
    });
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function update(id: number, data: UpdateBible): Promise<Result<Bible>> {
  try {
    const changes = Object.entries(data).filter(([, value]) => value !== undefined);
    if (!changes.length) return getById(id);
    return await runInTransaction(async (tx) => {
      await tx
        .update(bibles)
        .set(data)
        .where(
          and(
            eq(bibles.id, id),
            or(
              ...changes.map(
                ([key, value]) => sql`${bibles[key as keyof UpdateBible]} IS DISTINCT FROM ${value}`
              )
            )
          )
        );
      return getById(id, tx);
    });
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function remove(id: number): Promise<Result<void>> {
  try {
    const [deleted] = await db.delete(bibles).where(eq(bibles.id, id)).returning({ id: bibles.id });
    if (!deleted) return err(ErrorCode.BIBLE_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to delete bible', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function searchSourceBibles(query: string): Promise<Result<SourceSearchResponse>> {
  try {
    const cleanQuery = query.trim();
    const escapedQuery = cleanQuery.replace(/[\\%_]/g, '\\$&');
    const searchPattern = `%${escapedQuery}%`;

    const rows = await db
      .select({
        bibleId: bibles.id,
        bibleName: bibles.name,
        bibleAbbreviation: bibles.abbreviation,
        bibleProvider: bibleProjection.provider,
        bibleHasAudio: bibleProjection.hasAudio,
        languageId: languages.id,
        langName: languages.langName,
        langCodeIso6393: languages.langCodeIso6393,
      })
      .from(bibles)
      .innerJoin(languages, eq(bibles.languageId, languages.id))
      .leftJoin(canonicalResources, eq(bibles.textResourceId, canonicalResources.id))
      .where(
        cleanQuery.length > 0
          ? or(
              ilike(languages.langName, searchPattern),
              ilike(languages.langCodeIso6393, searchPattern),
              ilike(bibles.name, searchPattern),
              ilike(bibles.abbreviation, searchPattern)
            )
          : undefined
      )
      .orderBy(languages.langName, bibles.name)
      .limit(100);

    const languageMap = new Map<
      number,
      {
        id: number;
        langName: string;
        langCodeIso6393: string | null;
        bibles: {
          id: number;
          name: string;
          abbreviation: string;
          provider: string;
          hasAudio: boolean;
        }[];
      }
    >();

    const matchingBiblesList: {
      id: number;
      name: string;
      abbreviation: string;
      provider: string;
      hasAudio: boolean;
      languageId: number;
      languageName: string;
      languageCode: string | null;
    }[] = [];

    for (const row of rows) {
      if (!languageMap.has(row.languageId)) {
        languageMap.set(row.languageId, {
          id: row.languageId,
          langName: row.langName,
          langCodeIso6393: row.langCodeIso6393,
          bibles: [],
        });
      }

      const langEntry = languageMap.get(row.languageId)!;
      langEntry.bibles.push({
        id: row.bibleId,
        name: row.bibleName,
        abbreviation: row.bibleAbbreviation,
        provider: row.bibleProvider,
        hasAudio: row.bibleHasAudio,
      });

      matchingBiblesList.push({
        id: row.bibleId,
        name: row.bibleName,
        abbreviation: row.bibleAbbreviation,
        provider: row.bibleProvider,
        hasAudio: row.bibleHasAudio,
        languageId: row.languageId,
        languageName: row.langName,
        languageCode: row.langCodeIso6393,
      });
    }

    const languagesList = Array.from(languageMap.values()).map((lang) => ({
      id: lang.id,
      langName: lang.langName,
      langCodeIso6393: lang.langCodeIso6393,
      bibleCount: lang.bibles.length,
      bibles: lang.bibles,
    }));

    return ok({
      languages: languagesList,
      bibles: matchingBiblesList,
    });
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to search source bibles', context: { query } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

// ─── DBL sync ──────────────────────────────────────────────────────────────

const UPSERT_CHUNK_SIZE = 100;

interface DblBibleUpsertInput {
  languageId: number;
  name: string;
  abbreviation: string;
  textResourceId: number;
}

interface DblBibleUpsertSummary {
  inserted: number;
  updated: number;
}

/**
 * Upserts bibles keyed on `text_resource_id` — the natural identity
 * for externally-sourced Bibles. Uses DBL as the authoritative source for
 * the name, abbreviation, and language association if a conflict occurs.
 */
export async function upsertFromDbl(
  rows: DblBibleUpsertInput[],
  tx?: DbTransaction
): Promise<Result<DblBibleUpsertSummary>> {
  if (rows.length === 0) return ok({ inserted: 0, updated: 0 });

  try {
    let inserted = 0;
    let updated = 0;

    await (tx ?? db).transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
        const written = await tx
          .insert(bibles)
          .values(chunk)
          .onConflictDoUpdate({
            target: bibles.textResourceId,
            targetWhere: sql`${bibles.textResourceId} IS NOT NULL`,
            set: {
              name: sql`excluded.name`,
              abbreviation: sql`excluded.abbreviation`,
              languageId: sql`excluded.language_id`,
              // Advance watermark only when a tracked column actually changes.
              updatedAt: sql`
                CASE
                  WHEN bibles.name IS DISTINCT FROM excluded.name
                    OR bibles.abbreviation IS DISTINCT FROM excluded.abbreviation
                    OR bibles.language_id IS DISTINCT FROM excluded.language_id
                  THEN next_catalogue_watermark()
                  ELSE bibles.updated_at
                END`,
            },
            setWhere: sql`bibles.name IS DISTINCT FROM excluded.name
              OR bibles.abbreviation IS DISTINCT FROM excluded.abbreviation
              OR bibles.language_id IS DISTINCT FROM excluded.language_id`,
          })
          .returning({ wasInsert: sql<boolean>`(xmax = 0)` });

        for (const row of written) {
          if (row.wasInsert) inserted++;
          else updated++;
        }
      }
    });

    return ok({ inserted, updated });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert bibles from DBL',
      context: { rowCount: rows.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
