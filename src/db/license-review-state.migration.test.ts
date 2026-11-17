import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('license review state migration', () => {
  it('defaults legacy rows to unreviewed without borrowing the old file review time', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE license_classifications (
          normalized_text text PRIMARY KEY,
          status text NOT NULL,
          rationale jsonb,
          classified_by text,
          reviewed_at timestamptz,
          created_at timestamptz,
          updated_at timestamptz
        );
        INSERT INTO license_classifications
          (normalized_text, status, rationale, classified_by, reviewed_at)
        VALUES ('legacy', 'allowed', '"retained"', 'human', '2026-10-01T12:00:00.000Z');
      `);
      const migration = await readFile(
        new URL('./migrations/0046_license_review_state.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) await db.exec(statement);
      const result = await db.query(`
        SELECT status, rationale, classified_by, reviewed_at,
               review_state, decision_at, reviewed_by, human_reviewed_at
        FROM license_classifications WHERE normalized_text = 'legacy'
      `);
      expect(result.rows).toEqual([
        {
          status: 'allowed',
          rationale: 'retained',
          classified_by: 'human',
          reviewed_at: new Date('2026-10-01T12:00:00.000Z'),
          review_state: 'unreviewed',
          decision_at: null,
          reviewed_by: null,
          human_reviewed_at: null,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});
