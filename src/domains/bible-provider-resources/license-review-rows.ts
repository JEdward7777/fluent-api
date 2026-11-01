import type { LicenseArtifact } from './license-artifact.schemas';
import type { LicenseDatabaseContext } from './license-impact';
import type { LicenseReviewIo } from './license-review.types';

import {
  licenseOverrideWarning,
  overrideLicenseClassification,
  reviseLicenseArtifact,
} from './license-artifact';
import { computeLicenseImpact } from './license-impact';
import { freezeLicenseRevision } from './license-review-revision';

/** A single review view: search/filter, select a row, edit its fields, then return to the same view. */
export async function reviewLicenseRows(
  value: LicenseArtifact,
  io: LicenseReviewIo,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false,
  edit?: (
    change:
      | {
          kind: 'disposition';
          normalizedText: string;
          status: LicenseArtifact['classifications'][number]['status'];
          reason: string;
        }
      | { kind: 'unknown-note'; normalizedText: string; note: string }
  ) => LicenseArtifact
) {
  let artifact = value;
  let query = '';
  let status = 'all';
  while (true) {
    const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
    const visible = [...artifact.classifications]
      .sort((a, b) =>
        a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0
      )
      .filter((row) => {
        const bibles = impact.rows.filter((bible) => bible.normalizedText === row.normalizedText);
        const content = [
          row.normalizedText,
          row.exampleNotice,
          row.rationale,
          row.rowNote ?? '',
          ...bibles.map(
            (bible) => `${bible.name} ${bible.provider}:${bible.externalId} ${bible.bibleId ?? ''}`
          ),
        ]
          .join(' ')
          .toLowerCase();
        return (status === 'all' || row.status === status) && content.includes(query.toLowerCase());
      });
    await io.write(
      `${visible.length} classifications shown.\n${visible.map((row, index) => `${index + 1}. ${row.status}: ${JSON.stringify(row.normalizedText)}`).join('\n')}`
    );
    const command = (
      await io.ask(
        'Review: search text, /search <text or ID>, /all /allowed /forbidden /unknown, row number, or Enter to return: '
      )
    ).trim();
    if (!command) return artifact;
    if (command.toLowerCase() === '/search' || command.toLowerCase().startsWith('/search ')) {
      query = command.slice('/search'.length).trim();
      continue;
    }
    if (command.startsWith('/')) {
      const next = command.slice(1).toLowerCase();
      if (['all', 'allowed', 'forbidden', 'unknown'].includes(next)) status = next;
      else await io.write('Unknown filter. Use /all, /allowed, /forbidden, or /unknown.');
      continue;
    }
    if (!/^\d+$/.test(command)) {
      query = command;
      continue;
    }
    const row = visible[Number(command) - 1];
    if (!row) {
      await io.write(
        'No row with that number is shown. To search an ID, use /search followed by the ID.'
      );
      continue;
    }
    await io.write(
      `Selected ${JSON.stringify(row.normalizedText)}. Current ${row.status}: ${row.rationale}`
    );
    const affected = impact.rows.filter((bible) => bible.normalizedText === row.normalizedText);
    const notices = [
      ...new Set([row.exampleNotice, ...affected.map((bible) => bible.rawNotice ?? '')]),
    ];
    await io.write(
      [
        ...notices.map((notice) => `Raw notice: ${JSON.stringify(notice)}`),
        `Affected Bibles (${affected.length}):`,
        ...affected.map(
          (bible) =>
            `${JSON.stringify(bible.name)} [${bible.provider}:${bible.externalId}; Bible ID ${bible.bibleId ?? 'not assigned'}]`
        ),
        ...(row.automaticDecision
          ? [
              `Preserved automatic proposal: ${row.automaticDecision.status} (${row.automaticDecision.source}) — ${row.automaticDecision.rationale}`,
            ]
          : []),
        ...(row.rule
          ? [
              `Rule ${row.rule.id}, priority ${row.rule.priority}, ${row.rule.decision}; matched excerpt ${JSON.stringify(row.rule.matchedExcerpt)}.`,
            ]
          : []),
        ...row.samples.map(
          (sample) =>
            `Recorded model vote ${sample.provider}:${sample.model}, sample ${sample.index}: ${sample.result.decision} — ${sample.result.rationale}`
        ),
        ...(row.rowNote ? [`Human row note: ${row.rowNote}`] : []),
      ].join('\n')
    );
    const decision = (await io.ask('Decision allowed/forbidden/unknown, or Enter to keep: '))
      .trim()
      .toLowerCase();
    if (!decision || decision === 'keep') {
      if (row.status === 'unknown' && !row.rowNote) {
        const note = await io.ask(
          'Human note required to complete JSON while retaining unknown (Enter leaves unreviewed): '
        );
        if (note.trim())
          artifact = edit
            ? edit({ kind: 'unknown-note', normalizedText: row.normalizedText, note })
            : freezeLicenseRevision(
                reviseLicenseArtifact(artifact, (draft) => {
                  draft.classifications.find(
                    (entry) => entry.normalizedText === row.normalizedText
                  )!.rowNote = note;
                })
              );
        else await io.write('Unknown remains unreviewed; JSON cannot be marked complete.');
      }
      continue;
    }
    if (!['allowed', 'forbidden', 'unknown'].includes(decision)) {
      await io.write('Invalid decision; the row was not changed.');
      continue;
    }
    const selectedStatus =
      decision === 'allowed' ? 'allowed' : decision === 'forbidden' ? 'forbidden' : 'unknown';
    const warning = licenseOverrideWarning(row, selectedStatus);
    if (warning) await io.write(`WARNING: ${warning}`);
    const reason = await io.ask(
      'Reason for this human disposition (required; Enter cancels edit): '
    );
    if (!reason.trim()) {
      await io.write('No reason supplied; the row was not changed.');
      continue;
    }
    artifact = edit
      ? edit({
          kind: 'disposition',
          normalizedText: row.normalizedText,
          status: selectedStatus,
          reason,
        })
      : freezeLicenseRevision(
          overrideLicenseClassification(artifact, row.normalizedText, selectedStatus, reason)
            .artifact
        );
  }
}
