import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  bible_provider_resources,
  bibles,
  books,
  chapter_assignments,
  languages,
  organizations,
  pericope_sets,
  project_unit_bible_books,
  project_units,
  projects,
  roles,
  user_roles,
  users,
} from '@/db/schema';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { ROLES } from '@/lib/roles';

export const AUDIO_DEMO_SEED = 'source-audio-bsb-jhn';
const AUDIO_DEMO_PROJECT_NAME = 'Source Audio Demo — BSB John';

interface AudioDemoUsers {
  managerEmail?: string;
  translatorEmails?: readonly string[];
}

/** Only local setup creates a demo project; shared Dev/QA need their own chosen QA assignment. */
export async function seedAudioDemo(
  envName: string,
  orgName: string,
  demoUsers: AudioDemoUsers = {}
): Promise<void> {
  if (envName !== 'local') return;
  if (!demoUsers.managerEmail) {
    throw new Error('Audio demo needs a configured local project manager.');
  }
  const translatorEmails = demoUsers.translatorEmails ?? [];
  if (translatorEmails.length !== 2 || new Set(translatorEmails).size !== 2) {
    throw new Error('Audio demo needs two distinct configured local project translators.');
  }
  await db
    .insert(bible_provider_resources)
    .values({
      provider: 'aquifer',
      externalId: '20',
      ttsLicenseStatus: 'allowed',
      licenseNotice: 'World English Bible (WEB). Public domain.',
      displayName: 'World English Bible',
    })
    .onConflictDoNothing();

  const [
    orgRows,
    managerRows,
    translatorRows,
    bibleRows,
    bookRows,
    targetRows,
    pericopeRows,
    roleRows,
  ] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.name, orgName)),
    db.select().from(users).where(eq(users.email, demoUsers.managerEmail)),
    db.select().from(users).where(inArray(users.email, translatorEmails)),
    db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB')),
    db.select().from(books).where(eq(books.code, 'JHN')),
    db.select().from(languages).where(eq(languages.langCodeIso6393, 'guj')),
    db.select().from(pericope_sets).where(eq(pericope_sets.name, 'FCBH')),
    db
      .select()
      .from(roles)
      .where(inArray(roles.name, [ROLES.PROJECT_MANAGER, ROLES.PROJECT_TRANSLATOR])),
  ]);
  const [org] = orgRows;
  const [manager] = managerRows;
  const [bible] = bibleRows;
  const [book] = bookRows;
  const [target] = targetRows;
  const [pericopes] = pericopeRows;
  const managerRole = roleRows.find((role) => role.name === ROLES.PROJECT_MANAGER);
  const translatorRole = roleRows.find((role) => role.name === ROLES.PROJECT_TRANSLATOR);
  const translators = translatorEmails.map((email) =>
    translatorRows.find((translator) => translator.email === email)
  );
  const [translator, peerChecker] = translators;
  if (
    !org ||
    !manager ||
    !translator ||
    !peerChecker ||
    !bible ||
    !book ||
    !target ||
    !pericopes ||
    !managerRole ||
    !translatorRole
  ) {
    throw new Error(
      'Audio demo needs its organization, manager, two translators, BSB/JHN, Gujarati, FCBH and roles seeded first.'
    );
  }

  await db.transaction(async (tx) => {
    // Projects have no unique seed key. Serialize concurrent setup runs without adding a schema
    // constraint; the metadata marker avoids claiming a user-created project with the same name.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AUDIO_DEMO_SEED}))`);
    let [project] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organization, org.id),
          sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`
        )
      );
    if (!project) {
      [project] = await tx
        .insert(projects)
        .values({
          name: AUDIO_DEMO_PROJECT_NAME,
          sourceLanguage: bible.languageId,
          sourceBibleId: bible.id,
          targetLanguage: target.id,
          organization: org.id,
          createdBy: manager.id,
          status: 'active',
          pericopeSetId: pericopes.id,
          metadata: { seed: AUDIO_DEMO_SEED },
        })
        .returning();
    } else if (project.sourceBibleId === null) {
      // Earlier local seeds predate the milestone hierarchy. Preserve a selected Bible on reruns.
      await tx
        .update(projects)
        .set({ sourceBibleId: bible.id })
        .where(and(eq(projects.id, project.id), isNull(projects.sourceBibleId)));
    }
    let [unit] = await tx
      .select()
      .from(project_units)
      .where(eq(project_units.projectId, project.id))
      .orderBy(project_units.id);
    if (!unit) {
      [unit] = await tx
        .insert(project_units)
        .values({ projectId: project.id, name: project.name })
        .returning();
    } else if (!unit.name) {
      await tx
        .update(project_units)
        .set({ name: project.name })
        .where(and(eq(project_units.id, unit.id), eq(project_units.name, '')));
    }
    const [link] = await tx
      .select()
      .from(project_unit_bible_books)
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, unit.id),
          eq(project_unit_bible_books.bibleId, bible.id),
          eq(project_unit_bible_books.bookId, book.id)
        )
      );
    if (!link) {
      await tx
        .insert(project_unit_bible_books)
        .values({ projectUnitId: unit.id, bibleId: bible.id, bookId: book.id });
    }
    await tx
      .insert(user_roles)
      .values({
        userId: manager.id,
        orgId: org.id,
        projectId: project.id,
        roleId: managerRole.id,
        createdBy: manager.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(user_roles)
      .values(
        [translator, peerChecker].map((projectTranslator) => ({
          userId: projectTranslator.id,
          orgId: org.id,
          projectId: project.id,
          roleId: translatorRole.id,
          createdBy: manager.id,
        }))
      )
      .onConflictDoNothing();
    await tx
      .insert(chapter_assignments)
      .values({
        projectUnitId: unit.id,
        bibleId: bible.id,
        bookId: book.id,
        chapterNumber: 3,
        assignedUserId: translator.id,
        peerCheckerId: peerChecker.id,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        isAiEnabled: false,
      })
      .onConflictDoNothing({
        target: [
          chapter_assignments.projectUnitId,
          chapter_assignments.bibleId,
          chapter_assignments.bookId,
          chapter_assignments.chapterNumber,
        ],
      });
    // Reruns retain assignment ownership, progress and the suggestion toggle, not just verse IDs.
    console.log(`Audio demo ready: project ${project.id}, BSB John 3 (local only).`);
  });
}
