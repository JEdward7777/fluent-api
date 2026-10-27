import { and, count, eq, ilike, inArray, isNotNull, ne, notIlike, or, sql } from 'drizzle-orm';

import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';
import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { canonicalResources as bible_provider_resources } from '@/db/canonical-schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Provider, ProviderIdentity } from './bible-provider-resources.types';

// Preserve the recording-facing contract; application SELECTs never fetch the rollback alias.
const resourceColumns = {
  id: bible_provider_resources.id,
  provider: bible_provider_resources.provider,
  externalId: bible_provider_resources.externalId,
  ttsLicenseStatus: bible_provider_resources.ttsLicenseStatus,
  licenseNotice: bible_provider_resources.licenseNotice,
  displayName: bible_provider_resources.displayName,
};
export type BibleProviderResource = Pick<
  typeof bible_provider_resources.$inferSelect,
  keyof typeof resourceColumns
>;

async function find(where: ReturnType<typeof eq>): Promise<Result<BibleProviderResource | null>> {
  try {
    const [row] = await db
      .select(resourceColumns)
      .from(bible_provider_resources)
      .where(where)
      .limit(1);
    return ok(row ?? null);
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resource' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export function getById(id: number) {
  return find(eq(bible_provider_resources.id, id));
}

export function getByProviderIdentity(provider: Provider, externalId: string) {
  return find(
    and(
      eq(bible_provider_resources.provider, provider),
      eq(bible_provider_resources.externalId, externalId)
    )!
  );
}

export async function getByIds(ids: number[]) {
  if (ids.length === 0) return ok<BibleProviderResource[]>([]);
  try {
    return ok(
      await db
        .select(resourceColumns)
        .from(bible_provider_resources)
        .where(inArray(bible_provider_resources.id, ids))
    );
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resources by IDs' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByProviderIdentities(identities: ProviderIdentity[]) {
  if (identities.length === 0) return ok<BibleProviderResource[]>([]);
  try {
    return ok(
      await db
        .select(resourceColumns)
        .from(bible_provider_resources)
        .where(
          or(
            ...identities.map(({ provider, externalId }) =>
              and(
                eq(bible_provider_resources.provider, provider),
                eq(bible_provider_resources.externalId, externalId)
              )
            )
          )
        )
    );
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resources by identities' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export interface DblTextLicenseFact {
  externalId: string;
  textLicenseNotice: string | null;
  displayName: string;
  hasAudio: boolean;
}

/** The caller transaction also owns the Bible upsert; conflict never overwrites curated status. */
export async function upsertDblTextFacts(
  facts: DblTextLicenseFact[],
  initialStatus: TtsLicenseStatus,
  tx: DbTransaction,
  statuses?: ReadonlyMap<string, TtsLicenseStatus>
) {
  try {
    let inserted = 0;
    let updated = 0;
    // Chunk order bounds query size and keeps row/allocator locking deterministic.
    for (let offset = 0; offset < facts.length; offset += 100) {
      const rows = await tx
        .insert(bible_provider_resources)
        .values(
          facts.slice(offset, offset + 100).map((fact) => ({
            ...fact,
            provider: 'dbl' as const,
            ttsLicenseStatus: statuses?.get(fact.externalId) ?? initialStatus,
          }))
        )
        .onConflictDoUpdate({
          target: [bible_provider_resources.provider, bible_provider_resources.externalId],
          set: {
            textLicenseNotice: sql`excluded.text_license_notice`,
            displayName: sql`excluded.display_name`,
            hasAudio: sql`excluded.has_audio`,
            ...(statuses ? { ttsLicenseStatus: sql`excluded.tts_license_status` } : {}),
          },
          setWhere: sql`bible_provider_resources.text_license_notice IS DISTINCT FROM excluded.text_license_notice OR bible_provider_resources.display_name IS DISTINCT FROM excluded.display_name OR bible_provider_resources.has_audio IS DISTINCT FROM excluded.has_audio ${statuses ? sql`OR bible_provider_resources.tts_license_status IS DISTINCT FROM excluded.tts_license_status` : sql``}`,
        })
        .returning({ wasInsert: sql<boolean>`(xmax = 0)` });
      for (const row of rows) {
        if (row.wasInsert) inserted++;
        else updated++;
      }
    }
    const resources = facts.length
      ? await tx
          .select({
            id: bible_provider_resources.id,
            externalId: bible_provider_resources.externalId,
          })
          .from(bible_provider_resources)
          .where(
            and(
              eq(bible_provider_resources.provider, 'dbl'),
              inArray(
                bible_provider_resources.externalId,
                facts.map((fact) => fact.externalId)
              )
            )
          )
      : [];
    return ok({ inserted, updated, resources });
  } catch (cause) {
    logger.error({ cause, message: 'Failed to upsert DBL text license facts' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Transitional English-only sweep, invoked only by the deliberately named Phase-1 command. */
export async function applyAllRightsReservedSweep() {
  try {
    return await db.transaction(async (tx) => {
      const matching = and(
        eq(bible_provider_resources.provider, 'dbl'),
        ilike(bible_provider_resources.textLicenseNotice, '%all rights reserved%')
      );
      const changed = await tx
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: 'forbidden' })
        .where(and(matching, ne(bible_provider_resources.ttsLicenseStatus, 'forbidden')))
        .returning({ id: bible_provider_resources.id });
      const [[totals], unmatched] = await Promise.all([
        tx.select({ matched: count() }).from(bible_provider_resources).where(matching),
        tx
          .selectDistinct({ notice: sql<string>`${bible_provider_resources.textLicenseNotice}` })
          .from(bible_provider_resources)
          .where(
            and(
              eq(bible_provider_resources.provider, 'dbl'),
              isNotNull(bible_provider_resources.textLicenseNotice),
              notIlike(bible_provider_resources.textLicenseNotice, '%all rights reserved%')
            )
          )
          .orderBy(bible_provider_resources.textLicenseNotice),
      ]);
      return ok({
        matched: totals.matched,
        updated: changed.length,
        unmatchedDistinctNotices: unmatched.length,
        unmatchedNotices: unmatched.map((row) => row.notice),
      });
    });
  } catch (cause) {
    logger.error({ cause, message: 'Failed to apply the English all-rights-reserved sweep' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Current policy facts are read inside the same transaction as derived cache writes. */
export function getDblPolicyFacts(externalIds: string[], tx: DbTransaction) {
  return tx
    .select({
      externalId: bible_provider_resources.externalId,
      status: bible_provider_resources.ttsLicenseStatus,
    })
    .from(bible_provider_resources)
    .where(
      and(
        eq(bible_provider_resources.provider, 'dbl'),
        inArray(bible_provider_resources.externalId, externalIds)
      )
    );
}
