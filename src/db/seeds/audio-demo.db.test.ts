import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { config as localConfig } from '@/db/env-configs/local';
import {
  bible_texts,
  bibles,
  chapter_assignments,
  project_unit_bible_books,
  project_units,
  projects,
  roles,
  translated_verses,
  user_roles,
  users,
} from '@/db/schema';
import { findAssignmentsProgress } from '@/domains/chapter-assignments/progress/chapter-assignments-progress.repository';
import { getChapterPericopes } from '@/domains/pericopes/pericopes.service';
import { getAssignedChaptersByUserId } from '@/domains/users/chapter-assignments/users-chapter-assignments.service';
import { auth } from '@/lib/auth';
import { ROLES } from '@/lib/roles';
import { server } from '@/server/server';
import '@/domains/bibles/bibles.route';
import '@/domains/bibles/bible-texts/bible-texts.route';
import '@/domains/source-audio/source-audio.route';

import { AUDIO_DEMO_SEED, seedAudioDemo } from './audio-demo';
import { seedBsbBibleTexts } from './bible-texts-bsb';
import { seedBibles } from './bibles';

const localDemoUsers = (() => {
  const manager = localConfig.seedUsers.find((candidate) => candidate.role === 'project_manager');
  const translators = localConfig.seedUsers.filter(
    (candidate) => candidate.role === 'project_translator'
  );
  if (!manager || translators.length !== 2) {
    throw new Error('Local test config needs a manager and two translators.');
  }
  return {
    manager,
    translators,
    seedInput: {
      managerEmail: manager.email,
      translatorEmails: translators.map((translator) => translator.email),
    },
  };
})();

async function fixture() {
  const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
  const [manager] = await db
    .select()
    .from(users)
    .where(eq(users.email, localDemoUsers.manager.email));
  const translatorRows = await db
    .select()
    .from(users)
    .where(
      inArray(
        users.email,
        localDemoUsers.translators.map((translator) => translator.email)
      )
    );
  const [project] = await db
    .select()
    .from(projects)
    .where(sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`);
  const translator = translatorRows.find(
    (candidate) => candidate.email === localDemoUsers.translators[0]?.email
  );
  const peerChecker = translatorRows.find(
    (candidate) => candidate.email === localDemoUsers.translators[1]?.email
  );
  if (!bible || !manager || !translator || !peerChecker || !project) {
    throw new Error('Run local platform db:setup first.');
  }
  const [unit] = await db
    .select()
    .from(project_units)
    .where(eq(project_units.projectId, project.id));
  if (!unit) throw new Error('Demo project unit missing');
  const [assignment] = await db
    .select()
    .from(chapter_assignments)
    .where(
      and(eq(chapter_assignments.projectUnitId, unit.id), eq(chapter_assignments.chapterNumber, 3))
    );
  if (!assignment) throw new Error('Demo assignment missing');
  return { bible, manager, translator, peerChecker, project, unit, assignment };
}

describe('seeded BSB audio fixture (real database and authentication)', () => {
  let headers: { Authorization: string };
  beforeAll(async () => {
    await fixture();
    const login = await auth.api.signInEmail({
      body: {
        email: localDemoUsers.translators[0]!.email,
        password: localDemoUsers.translators[0]!.password,
      },
    });
    headers = { Authorization: `Bearer ${login.token}` };
  });

  it('publishes allowed + notice on GET /bibles and GET /bibles/{id}', async () => {
    const { bible } = await fixture();
    const res = await server.request(`/bibles/${bible.id}`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: bible.id,
      provider: 'dbl',
      ttsLicenseStatus: 'allowed',
      textBibleKey: 'dbl-bba9f40183526463-01',
      selectedRecordingKey: 'aq-1',
    });
    const list = await server.request('/bibles', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ abbreviation: 'BSB', ttsLicenseStatus: 'allowed' }),
        expect.objectContaining({ abbreviation: 'IRV', ttsLicenseStatus: 'unknown' }),
      ])
    );
  });

  it('gives the seeded user a drafting assignment with 36 texts and pericope coverage', async () => {
    const { bible, manager, translator, peerChecker, project, unit, assignment } = await fixture();
    expect(project.createdBy).toBe(manager.id);
    expect(assignment.assignedUserId).toBe(translator.id);
    expect(assignment.peerCheckerId).toBe(peerChecker.id);
    expect(assignment.status).toBe('draft');
    const projectRoles = await db
      .select({ email: users.email, role: roles.name })
      .from(user_roles)
      .innerJoin(users, eq(users.id, user_roles.userId))
      .innerJoin(roles, eq(roles.id, user_roles.roleId))
      .where(eq(user_roles.projectId, project.id));
    expect(projectRoles).toEqual(
      expect.arrayContaining([
        { email: manager.email, role: ROLES.PROJECT_MANAGER },
        { email: translator.email, role: ROLES.PROJECT_TRANSLATOR },
        { email: peerChecker.email, role: ROLES.PROJECT_TRANSLATOR },
      ])
    );
    expect(project.sourceBibleId).toEqual(expect.any(Number));
    expect(unit.name.trim()).not.toBe('');
    const assigned = await getAssignedChaptersByUserId(translator.id, project.organization);
    expect(assigned).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          chapterAssignmentId: assignment.id,
          bibleId: bible.id,
          totalVerses: 36,
          ttsLicenseStatus: 'allowed',
          textBibleKey: 'dbl-bba9f40183526463-01',
          selectedRecordingKey: 'aq-1',
          isAiEnabled: false,
        }),
      ]),
    });
    const texts = await server.request(
      `/bibles/${bible.id}/books/${assignment.bookId}/chapters/3/texts`,
      { headers }
    );
    expect(texts.status).toBe(200);
    expect(await texts.json()).toHaveLength(36);
    const pericopes = await getChapterPericopes(project.id, 'JHN', 3);
    expect(pericopes.ok).toBe(true);
    if (!pericopes.ok) throw new Error('Pericope lookup failed');
    const verses = pericopes.data.flatMap((group) =>
      group.verses.map((verse) => verse.verseNumber)
    );
    expect([...new Set(verses)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    );
  });

  it('repairs legacy missing milestone fields without replacing the seeded work', async () => {
    const { bible, project, unit, assignment } = await fixture();
    try {
      await db.update(projects).set({ sourceBibleId: null }).where(eq(projects.id, project.id));
      await db.update(project_units).set({ name: '' }).where(eq(project_units.id, unit.id));

      await seedAudioDemo('local', localConfig.orgName, localDemoUsers.seedInput);
      const repaired = await fixture();
      expect(repaired.project.sourceBibleId).toBe(bible.id);
      expect(repaired.unit.name).toBe(project.name);
      expect(repaired.assignment).toEqual(assignment);

      await seedAudioDemo('local', localConfig.orgName, localDemoUsers.seedInput);
      const repeated = await fixture();
      expect(repeated.project).toEqual(repaired.project);
      expect(repeated.unit).toEqual(repaired.unit);
      expect(repeated.assignment).toEqual(assignment);
    } finally {
      await Promise.all([
        db
          .update(projects)
          .set({ sourceBibleId: project.sourceBibleId, updatedAt: project.updatedAt })
          .where(eq(projects.id, project.id)),
        db
          .update(project_units)
          .set({ name: unit.name, updatedAt: unit.updatedAt })
          .where(eq(project_units.id, unit.id)),
      ]);
    }
  });

  it('executes the aggregated progress query with Bible license columns and unchanged assignment grain', async () => {
    const { bible, project, assignment } = await fixture();
    const progress = await findAssignmentsProgress({ projectId: project.id });
    expect(progress.ok).toBe(true);
    if (!progress.ok) throw new Error('Assignment progress query failed');
    const matching = progress.data.filter((row) => row.assignmentId === assignment.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      bibleId: bible.id,
      ttsLicenseStatus: 'allowed',
      textBibleKey: 'dbl-bba9f40183526463-01',
      selectedRecordingKey: 'aq-1',
      totalVerses: 36,
    });
  });

  it('reruns shared seeds without replacing verses, assignments or translator work', async () => {
    const { bible, translator, project, unit, assignment } = await fixture();
    const before = await db
      .select()
      .from(bible_texts)
      .where(eq(bible_texts.bibleId, bible.id))
      .orderBy(bible_texts.id);
    expect(before).toHaveLength(878);
    const verse = before.find((row) => row.chapterNumber === 3 && row.verseNumber === 1)!;
    const [draft] = await db
      .insert(translated_verses)
      .values({
        projectUnitId: unit.id,
        bibleTextId: verse.id,
        assignedUserId: translator.id,
        content: 'Seed rerun sentinel',
      })
      .onConflictDoNothing()
      .returning();
    try {
      const translationsBefore = await db
        .select()
        .from(translated_verses)
        .where(eq(translated_verses.projectUnitId, unit.id))
        .orderBy(translated_verses.id);
      await seedBibles();
      await seedBsbBibleTexts();
      await seedAudioDemo('local', localConfig.orgName, localDemoUsers.seedInput);
      const after = await fixture();
      expect(after.bible).toMatchObject({
        externalId: 'bba9f40183526463-01',
        audioResourceId: bible.audioResourceId,
      });
      expect(after.project.id).toBe(project.id);
      expect(after.assignment).toEqual(assignment);
      expect(
        await db
          .select()
          .from(bible_texts)
          .where(eq(bible_texts.bibleId, bible.id))
          .orderBy(bible_texts.id)
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(project_unit_bible_books)
          .where(eq(project_unit_bible_books.projectUnitId, unit.id))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(translated_verses)
          .where(eq(translated_verses.projectUnitId, unit.id))
          .orderBy(translated_verses.id)
      ).toEqual(translationsBefore);
    } finally {
      if (draft) await db.delete(translated_verses).where(eq(translated_verses.id, draft.id));
    }
  });

  it('never creates the demo for shared Dev or QA, even without configured users', async () => {
    const before = await db.select().from(projects).orderBy(projects.id);
    await seedAudioDemo('dev', 'Not a real org');
    await seedAudioDemo('qa', 'Not a real org');
    expect(await db.select().from(projects).orderBy(projects.id)).toEqual(before);
  });
});
