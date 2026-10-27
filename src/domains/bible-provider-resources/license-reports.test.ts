import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from './license-artifact';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { parseLicenseVote } from './license-model-contract';
import { normalizeLicenseNotice } from './license-normalizer';
import { escapeReportHtml, selectLicenseReportFormats } from './license-report-formats';
import { makeLicenseImpactFixture } from './license-report.test-fixtures';
import { renderLicenseReports } from './license-reports';

describe('selectable frozen license reports', () => {
  it('defaults to Markdown, deduplicates selections and validates explicit browser requests', () => {
    expect(selectLicenseReportFormats()).toEqual(['markdown']);
    expect(selectLicenseReportFormats(' html,markdown,html ')).toEqual(['html', 'markdown']);
    expect(selectLicenseReportFormats('none')).toEqual([]);
    for (const value of ['', 'other', 'html,none', 'markdown,'])
      expect(() => selectLicenseReportFormats(value)).toThrow();
    for (const options of [
      { openReport: true },
      { openReport: true, interactive: true, yes: true },
      { openReport: true, interactive: false },
    ])
      expect(() => selectLicenseReportFormats('html', options)).toThrow('requires HTML');
    expect(() =>
      selectLicenseReportFormats('markdown', { interactive: true, openReport: true })
    ).toThrow();
    expect(selectLicenseReportFormats('html', { interactive: true, openReport: true })).toEqual([
      'html',
    ]);
  });
  it('renders both formats from identical detached data with exact artifact hashes and complete inventory', () => {
    const { artifact, database } = makeLicenseImpactFixture();
    const before = structuredClone(artifact);
    const both = renderLicenseReports(artifact, { formats: 'markdown,html', database });
    const markdown = renderLicenseReports(artifact, { database });
    const html = renderLicenseReports(artifact, { formats: 'html', database });
    expect(both.artifactBytes).toBe(serializeLicenseArtifact(both.artifact).bytes);
    expect(both.wholeFileHash).toBe(markdown.wholeFileHash);
    expect(html.reviewContentHash).toBe(markdown.reviewContentHash);
    expect(both.model).toEqual(markdown.model);
    expect(both.model).toEqual(html.model);
    for (const report of both.reports) {
      expect(report.bytes).toContain(both.reviewContentHash);
      expect(report.bytes).toContain(both.wholeFileHash);
      expect(report.bytes).toContain('ordinary table-derived sync');
      expect(report.bytes).toContain('Recorded evidence diagnostics');
      expect(report.bytes).toContain('New Bible');
      expect(report.bytes).toContain('Retained database Bible');
      expect(report.bytes).toContain('Earlier licensing notice.');
      expect(report.bytes).toContain('Normalization collisions');
      expect(report.bytes).toContain('Model evidence:');
      expect(report.path).toContain('.temp/license-reports/license-impact.');
    }
    const md = both.reports[0].bytes;
    expect(md.split('## Complete license inventory')[0]).not.toContain('Bible 3');
    expect(md).toContain('<details><summary>Affected Bibles (2)</summary>');
    expect(md).toContain('Bible ID 1');
    expect(md).toContain('recorded-model-a');
    expect(both.reports[1].url).toMatch(/^file:\/\//);
    expect(both.reports[1].bytes).toContain('type="search"');
    expect(both.reports[1].bytes).toContain('entry.hidden=');
    expect(both.reports[1].bytes).not.toMatch(/(?:src|href)=["']https?:/);
    expect(artifact).toEqual(before);
    expect(Object.isFrozen(both.model.inventory[0].bibles)).toBe(true);
    expect(() => {
      both.artifact.catalog[0].name = 'mutated';
    }).toThrow();
  });
  it('executes the self-contained HTML search/status filters against the rendered inventory', () => {
    const html = renderLicenseReports(makeLicenseArtifact(), { formats: 'html' }).reports[0].bytes;
    const entries = [
      ...html.matchAll(
        /<article class="license-entry" data-status="([^"]*)" data-search="([^"]*)">/g
      ),
    ].map((match) => ({ dataset: { status: match[1], search: match[2] }, hidden: false }));
    const listeners = new Map<string, () => void>();
    const control = (event: string) => ({
      value: '',
      addEventListener: (_name: string, callback: () => void) => {
        listeners.set(event, callback);
      },
    });
    const search = control('input');
    const status = control('change');
    status.value = 'all';
    const count = { textContent: '' };
    const document = {
      getElementById: (id: string) =>
        id === 'license-search' ? search : id === 'license-status' ? status : count,
      querySelectorAll: () => entries,
    };
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { document });
    expect(entries.filter((entry) => !entry.hidden)).toHaveLength(3);
    search.value = 'publisher';
    listeners.get('input')!();
    expect(entries.filter((entry) => !entry.hidden)).toMatchObject([
      { dataset: { status: 'allowed' } },
    ]);
    status.value = 'forbidden';
    listeners.get('change')!();
    expect(entries.every((entry) => entry.hidden)).toBe(true);
    expect(count.textContent).toBe('0 classification entries shown');
    search.value = '';
    listeners.get('input')!();
    expect(entries.filter((entry) => !entry.hidden)).toHaveLength(1);
    status.value = 'all';
    listeners.get('change')!();
    expect(entries.filter((entry) => !entry.hidden)).toHaveLength(3);
  });

  it('prominently discloses unavailable production impact offline, including formats none', () => {
    const artifact = makeLicenseArtifact();
    for (const format of ['markdown', 'html']) {
      const report = renderLicenseReports(artifact, { formats: format });
      expect(report.reports[0].bytes).toContain(
        'Production impact is unavailable because no database context was supplied.'
      );
      expect(report.reports[0].bytes).toContain('artifact-only report');
      expect(report.model.impact.ttsGains).toBeNull();
    }
    const none = renderLicenseReports(artifact, { formats: 'none' });
    expect(none.reports).toEqual([]);
    expect(none.model.inventory).toHaveLength(artifact.classifications.length);
  });
  it('shows invocation-scoped preservation disagreements and unchanged records only as main-body aggregates', () => {
    const { artifact, database } = makeLicenseImpactFixture();
    const reports = renderLicenseReports(artifact, {
      database,
      formats: 'markdown,html',
      preserveExistingNonUnknowns: true,
    });
    expect(reports.model.impact.disagreements).toHaveLength(3);
    for (const report of reports.reports) {
      expect(report.bytes).toContain('this invocation only');
      expect(report.bytes).toContain('Preservation disagreement');
      expect(report.bytes).toContain('retains allowed');
      expect(report.bytes).toContain('A later ordinary sync');
    }
  });
  it.each([null, 1234])(
    'displays actual existing database Bible IDs in both reports when the artifact ID is %s',
    (artifactId) => {
      const fixture = makeLicenseImpactFixture();
      const artifact = reviseLicenseArtifact(fixture.artifact, (draft) => {
        draft.catalog[0].bibleId = artifactId;
      });
      fixture.database.resources[0].bibleId = 9876;
      fixture.database.resources[0].name = 'Actual loaded Bible';
      fixture.database.resources[0].abbreviation = 'ACTUAL';
      const reports = renderLicenseReports(artifact, {
        database: fixture.database,
        formats: 'markdown,html',
      });
      const entry = reports.model.inventory.find(
        (row) => row.normalizedText === artifact.classifications[0].normalizedText
      )!;
      expect(
        entry.bibles.find((bible) => bible.externalId === artifact.catalog[0].externalId)?.bibleId
      ).toBe(9876);
      for (const report of reports.reports) {
        expect(report.bytes).toContain('Bible ID 9876');
        expect(report.bytes).toContain('Actual loaded Bible');
      }
      expect(reports.artifact.catalog[0].bibleId).toBe(artifactId);
      expect(artifact.catalog[0].bibleId).toBe(artifactId);
    }
  );

  it('safely escapes hostile notice/name/note/model evidence without embedded user script or Markdown links', () => {
    const malicious =
      '</script><img src=x onerror="alert(1)">[run](javascript:alert(1)) & `literal`\n# heading';
    const artifact = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      draft.catalog[0].name = malicious;
      const row = draft.classifications[2];
      row.exampleNotice = malicious;
      row.normalizedText = normalizeLicenseNotice(malicious);
      row.rowNote = malicious;
      row.rationale = malicious;
      draft.catalog[2].rawNotice = malicious;
      const sample = draft.classifications[1].samples[0];
      sample.response = JSON.stringify({ rationale: malicious, decision: 'allowed' });
      sample.result = parseLicenseVote(sample.response);
    });
    const reports = renderLicenseReports(artifact, { formats: 'markdown,html' });
    for (const report of reports.reports) {
      expect(report.bytes).not.toContain('<img');
      expect(report.bytes).toContain('&lt;/script&gt;');
      expect(report.bytes).toContain(`<pre>${escapeReportHtml(malicious)}</pre>`);
    }
    const html = reports.reports[1].bytes;
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(reports.reports[0].bytes).toContain('&#91;run&#93;');
    expect(reports.reports[0].bytes).not.toContain('<script>');
  });
  it.each(['missing attestation', 'wrong binding', 'unknown without note'])(
    'never labels %s as attested even with the marker removed',
    (condition) => {
      const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
      if (condition === 'missing attestation') delete artifact.attestation;
      else if (condition === 'wrong binding')
        artifact.attestation!.reviewContentHash = 'f'.repeat(64);
      else delete artifact.classifications[2].rowNote;
      delete artifact.reviewState;
      const report = renderLicenseReports(artifact, { formats: 'markdown,html' });
      expect(report.model.reviewState).toBe('incomplete');
      expect(report.model.attestation).toBeNull();
      expect(checkLicenseArtifactReview(JSON.parse(report.artifactBytes)).status).toBe(
        'review-required'
      );
      for (const rendered of report.reports) expect(rendered.bytes).not.toContain('Attested by');
    }
  );
});
