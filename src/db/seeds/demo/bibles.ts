import { and, eq, inArray, ne } from 'drizzle-orm';

import type { SeedBibleRow } from '@/db/seeds/bible-identity';

import { db } from '@/db';
import {
  canonicalResources as bible_provider_resources,
  bibleProjection,
  canonicalBibles as bibles,
} from '@/db/canonical-schema';
import { bible_books, books } from '@/db/schema';
import { resolveBibleByIdentity } from '@/db/seeds/bible-identity';

import type { DemoCtx } from './context';

// ─── Stage 3: bibles + book links ───────────────────────────────────────────

export async function seedSpecBibles(ctx: DemoCtx) {
  // Books used anywhere in the spec — resolve codes once.
  const codes = new Set<string>();
  for (const b of ctx.spec.bibles ?? []) for (const c of b.books ?? []) codes.add(c);
  for (const p of ctx.spec.projects)
    for (const m of p.milestones) for (const bk of m.books) codes.add(bk.code);

  if (codes.size) {
    const rows = await db
      .select({ id: books.id, code: books.code })
      .from(books)
      .where(inArray(books.code, [...codes]));
    for (const r of rows) ctx.books.set(r.code, r.id);
    const missing = [...codes].filter((c) => !ctx.books.has(c));
    if (missing.length) {
      throw new Error(`Unknown book codes: ${missing.join(', ')} — run db:seed:books first`);
    }
  }

  for (const spec of ctx.spec.bibles ?? []) {
    const languageId = ctx.languages.get(spec.language)!;

    // Provider-resource identities — the text row backs the TTS license
    // gate (`bibleKey` lookups), the audio row is the selectable recording.
    // Bare provider ids only; the `dbl-…` bibleKey form lives in responses.
    // Insert-only like seeds/bibles.ts: spec values seed a missing row, but
    // an existing row's license state and display name are operator-owned —
    // a reseed never rewrites them.
    const ensureResource = async (externalId: string, displayName: string, hasAudio = false) => {
      await db
        .insert(bible_provider_resources)
        .values({
          provider: 'dbl',
          externalId,
          ttsLicenseStatus: spec.ttsLicenseStatus ?? 'unknown',
          licenseNotice: spec.licenseNotice,
          displayName,
          hasAudio,
        })
        .onConflictDoNothing();
      const [row] = await db
        .select({ id: bible_provider_resources.id })
        .from(bible_provider_resources)
        .where(
          and(
            eq(bible_provider_resources.provider, 'dbl'),
            eq(bible_provider_resources.externalId, externalId)
          )
        )
        .limit(1);
      if (!row) {
        throw new Error(`provider resource dbl/${externalId} missing after insert`);
      }
      return row.id;
    };
    const textResourceId = spec.externalId
      ? await ensureResource(spec.externalId, spec.name, spec.hasAudio ?? false)
      : undefined;
    const audioResourceId = spec.audioExternalId
      ? await ensureResource(spec.audioExternalId, `${spec.name} audio`)
      : undefined;

    // Resolve by upstream identity (shared with seeds/bibles.ts so both
    // converge on one row — see resolveBibleByIdentity).
    const resolved = await resolveBibleByIdentity(spec);
    const effectiveTextResourceId = textResourceId ?? resolved.existing?.textResourceId;
    if (
      (!resolved.existing || resolved.existing.audioResourceId === null) &&
      effectiveTextResourceId != null &&
      spec.hasAudio !== undefined
    ) {
      await db
        .update(bible_provider_resources)
        .set({ hasAudio: spec.hasAudio })
        .where(
          and(
            eq(bible_provider_resources.id, effectiveTextResourceId),
            ne(bible_provider_resources.hasAudio, spec.hasAudio)
          )
        );
    }
    let bible: SeedBibleRow;
    if (resolved.existing) {
      bible = resolved.existing;
      const patch = demoBiblePatch(bible, textResourceId, audioResourceId);
      if (Object.keys(patch).length)
        await db.update(bibles).set(patch).where(eq(bibles.id, bible.id));
    } else {
      const [inserted] = await db
        .insert(bibles)
        .values({
          abbreviation: resolved.abbreviation,
          name: resolved.name,
          languageId,
          textResourceId,
          audioResourceId,
        })
        .returning({ id: bibles.id });
      const [created] = await db
        .select({
          id: bibles.id,
          provider: bibleProjection.provider,
          abbreviation: bibles.abbreviation,
          name: bibles.name,
          externalId: bible_provider_resources.externalId,
          hasAudio: bibleProjection.hasAudio,
          audioResourceId: bibles.audioResourceId,
          textResourceId: bibles.textResourceId,
        })
        .from(bibles)
        .leftJoin(bible_provider_resources, eq(bibles.textResourceId, bible_provider_resources.id))
        .where(eq(bibles.id, inserted.id));
      bible = created;
      console.log(`  bible ${resolved.abbreviation}`);
    }
    ctx.bibles.set(spec.abbreviation, bible.id);

    // Link books — dedupe existing links like seeds/bibles.ts does.
    const linked = await db
      .select({ bookId: bible_books.bookId })
      .from(bible_books)
      .where(eq(bible_books.bibleId, bible.id));
    const linkedIds = new Set(linked.map((l) => l.bookId));
    const toInsert = (spec.books ?? [])
      .map((code) => ctx.books.get(code)!)
      .filter((id) => !linkedIds.has(id))
      .map((bookId) => ({ bibleId: bible.id, bookId }));
    if (toInsert.length) await db.insert(bible_books).values(toInsert);
  }

  // Resolve bible abbreviations referenced by projects (may be reference
  // data). Spec bibles were already resolved by upstream identity above — a
  // by-abbreviation hit on those keys can be a *different* row (e.g. bare
  // 'BSB' vs the adopted 'BSB-bba9f4'), so only look up unresolved keys.
  const abbrevs = new Set<string>([
    ...(ctx.spec.bibles ?? []).map((b) => b.abbreviation),
    ...ctx.spec.projects.map((p) => p.sourceBible),
  ]);
  const unresolved = [...abbrevs].filter((a) => !ctx.bibles.has(a));
  if (unresolved.length) {
    const rows = await db
      .select({ id: bibles.id, abbreviation: bibles.abbreviation })
      .from(bibles)
      .where(inArray(bibles.abbreviation, unresolved));
    for (const r of rows) ctx.bibles.set(r.abbreviation, r.id);
  }
  const missing = [...abbrevs].filter((a) => !ctx.bibles.has(a));
  if (missing.length) {
    throw new Error(`Unknown bibles: ${missing.join(', ')} — not in spec or reference data`);
  }
}

/**
 * The reconcile patch for an adopted spec bible. The resolver ensures a
 * text-resource claim never replaces another provider identity. Audio follows the
 * curated-selection rule as seeds/bibles.ts: an operator-chosen recording or
 * hasAudio flag isn't seed-owned drift, so spec audio values only fill an
 * empty audio slot.
 */
export function demoBiblePatch(
  bible: Pick<SeedBibleRow, 'textResourceId' | 'audioResourceId'>,
  textResourceId: number | undefined,
  audioResourceId: number | undefined
): { textResourceId?: number; audioResourceId?: number } {
  const patch: { textResourceId?: number; audioResourceId?: number } = {};
  if (textResourceId !== undefined && bible.textResourceId !== textResourceId)
    patch.textResourceId = textResourceId;
  if (bible.audioResourceId === null) {
    if (audioResourceId !== undefined) patch.audioResourceId = audioResourceId;
  }
  return patch;
}
