import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import {
  createLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { normalizeLicenseNotice } from '../license-normalizer';
import { makeCommandFixture } from './license-command.test-fixtures';
import { start } from './license-reassessment-http.test-fixtures';
import { licenseReviewRowId } from './license-workbench-review';
import { LicenseWorkflow } from './license-workflow';

it('reconciles saved-as human work, separately accepted free and paid results, sticky intent and an incoming decision', async () => {
  const f = await makeCommandFixture(false);
  const fixture = f.artifact;
  const extra = ['Sticky terms', 'External terms'].map((exampleNotice) => ({
    ...fixture.classifications[2],
    exampleNotice,
    normalizedText: normalizeLicenseNotice(exampleNotice),
  }));
  const original = createLicenseArtifact({
    ...fixture,
    classifications: [...fixture.classifications, ...extra],
  });
  await writeFile(f.input, serializeLicenseArtifact(original).bytes);
  const [free, paid, saved, sticky, incoming] = original.classifications;
  const workflow = new LicenseWorkflow(f.options, {
    ...f.dependencies,
    destinationDatabase: f.dependencies.database,
  });
  const revision = () => workflow.status.contentRevision;
  const mark = (key: string, kind: 'mark' | 'revert') =>
    workflow.mutateDraft(
      {
        kind,
        id: licenseReviewRowId(key),
        contentRevision: revision(),
        mutationId: crypto.randomUUID(),
        epoch: workflow.reviewDrafts.epoch,
      },
      true
    );
  try {
    await workflow.inspect(1);
    expect(mark(saved.normalizedText, 'mark').conflict).toBe(false);
    const preview = await workflow.preview(1, revision(), 'Historical reviewer');
    await workflow.save({
      configurationRevision: 1,
      contentRevision: revision(),
      previewToken: preview.token,
      operationId: 'save-as',
      agreeToReplace: false,
    });
    const savedBytes = await readFile(f.output, 'utf8');
    expect(revision()).toBe(preview.contentRevision + 1);
    expect(workflow.reviewDrafts.size).toBe(0);
    expect(mark(saved.normalizedText, 'mark').conflict).toBe(false);
    expect(mark(saved.normalizedText, 'revert').values?.reviewedBy).toBe('Historical reviewer');
    await workflow.prepareFree(revision(), {
      kind: 'rule',
      id: licenseReviewRowId(free.normalizedText),
    });
    expect(
      workflow.analyzed!.artifact.classifications.find(
        (row) => row.normalizedText === free.normalizedText
      )?.decisionAt
    ).toEqual(expect.any(String));
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const estimate = await workflow.prepareFree(revision(), {
      kind: 'model',
      id: licenseReviewRowId(paid.normalizedText),
    });
    await workflow.runPaid(
      {
        maximumRequests: estimate.expectedUncachedRequests,
        fingerprint: estimate.fingerprint,
        replacementConfirmations: [],
      },
      { attempts: 0, completedRows: 0 }
    );
    expect(f.dependencies.transport).toHaveBeenCalledTimes(f.options.sampleCount);
    expect(mark(sticky.normalizedText, 'mark').conflict).toBe(false);
    const before = workflow.analyzed!;
    const external = [paid, sticky, incoming].reduce(
      (artifact, row) =>
        recordHumanLicenseDecision(
          artifact,
          row.normalizedText,
          'forbidden',
          { reviewComment: 'External decision' },
          'External',
          '2026-11-24T08:00:00.000Z'
        ),
      original
    );
    await writeFile(f.input, serializeLicenseArtifact(external).bytes);
    await expect(workflow.preview(1, revision(), 'Next')).rejects.toThrow(
      'Inspected inputs changed'
    );
    const proposal = await workflow.reconcileSource();
    if (!proposal.changes) throw new Error('Expected source proposal');
    const conflicts = proposal.changes.filter((row) => row.conflict);
    expect(conflicts.map((row) => row.label).sort()).toEqual(
      [paid, sticky].map((row) => `Classification ${row.normalizedText}`).sort()
    );
    await expect(workflow.reconcileSource({ token: proposal.token, choices: {} })).rejects.toThrow(
      'Choose a version'
    );
    expect(workflow.analyzed).toBe(before);
    expect(workflow.reviewDrafts.size).toBe(1);
    await workflow.reconcileSource({
      token: proposal.token,
      choices: Object.fromEntries(
        conflicts.map((change) => [change.id, change.pending ? 'source-with-mark' : 'working'])
      ),
    });
    const row = (key: string) =>
      workflow.analyzed!.artifact.classifications.find((item) => item.normalizedText === key)!;
    for (const item of [saved, free, paid])
      expect(row(item.normalizedText)).toEqual(
        before.artifact.classifications.find(
          (current) => current.normalizedText === item.normalizedText
        )
      );
    expect(row(incoming.normalizedText).reviewedBy).toBe('External');
    expect(workflow.reviewDrafts.values(row(sticky.normalizedText))).toMatchObject({
      pending: true,
      status: sticky.status,
    });
    expect(mark(sticky.normalizedText, 'revert').values).toMatchObject({
      pending: false,
      status: 'forbidden',
      reviewedBy: 'External',
    });
    expect(await readFile(f.output, 'utf8')).toBe(savedBytes);
    expect((await workflow.preview(1, revision())).candidate.artifact).toEqual(
      workflow.analyzed!.artifact
    );
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it('rejects a stale HTTP reconciliation and retains deleted rows until explicitly accepted', async () => {
  const f = await makeCommandFixture(false);
  const app = await start(f);
  try {
    const loaded = await app.operate('inspect');
    const row = f.artifact.classifications[2];
    const id = licenseReviewRowId(row.normalizedText);
    const list = (await app.api('review')).body;
    const patch = {
      kind: 'patch',
      epoch: list.epoch,
      contentRevision: list.contentRevision,
      id,
      mutationId: crypto.randomUUID(),
      touched: true,
      reviewComment: 'Keep pending evidence',
    };
    const ack = await app.api('review/draft', patch);
    const preview = {
      configurationRevision: loaded.configurationRevision,
      contentRevision: ack.body.contentRevision,
      reviewedBy: 'Reviewer',
    };
    const quote = (
      await app.api('review/rerun', {
        kind: 'model',
        id,
        operationId: crypto.randomUUID(),
        configurationRevision: loaded.configurationRevision,
        contentRevision: ack.body.contentRevision,
        estimateRevision: loaded.estimateRevision,
      })
    ).body;
    expect(quote.selectedModelId).toBe(id);
    const incoming = createLicenseArtifact({
      ...f.artifact,
      classifications: f.artifact.classifications.slice(0, 2),
      catalog: f.artifact.catalog.slice(0, 2),
    });
    await writeFile(f.input, serializeLicenseArtifact(incoming).bytes);
    expect((await app.api('preview', preview)).status).toBe(409);
    expect((await app.api('setup')).body.sourceChanged).toBe(true);
    const proposal = (await app.api('source/reconcile', {})).body;
    const deleted = proposal.changes.find((item: { conflict: boolean }) => item.conflict);
    expect(deleted).toMatchObject({
      label: `Classification ${row.normalizedText}`,
      source: null,
      pending: { pending: true },
    });
    const choices = { [deleted.id]: 'source' };
    await writeFile(f.input, `${serializeLicenseArtifact(incoming).bytes}\n`);
    expect((await app.api('source/reconcile', { token: proposal.token, choices })).status).toBe(
      409
    );
    expect((await app.api(`review/${id}`)).body.reviewComment).toBe('Keep pending evidence');
    const rejected = (await app.api('setup')).body;
    expect(rejected.paidEstimate).toEqual(quote.paidEstimate);
    expect(rejected.estimateRevision).toBe(quote.estimateRevision);
    const refreshed = (await app.api('source/reconcile', {})).body;
    expect((await app.api('source/reconcile', { token: refreshed.token, choices })).status).toBe(
      200
    );
    const accepted = (await app.api('setup')).body;
    expect(accepted).toMatchObject({
      sourceChanged: false,
      selectedModelId: null,
      canceledModelId: id,
      paidEstimate: null,
      reassessmentSourceChange: { id, notice: row.exampleNotice, outcome: 'closed' },
    });
    expect(accepted.estimateRevision).toBeGreaterThan(quote.estimateRevision);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    expect(accepted.analysis.pendingReviews).toBe(0);
    expect(accepted.inspected.sourceHash).toBe(
      createHash('sha256')
        .update(await readFile(f.input))
        .digest('hex')
    );
    expect(
      (await app.api('review')).body.rows.some((entry: { id: string }) => entry.id === id)
    ).toBe(false);
    await expect(readFile(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await app.close();
    await f.cleanup();
  }
});

it.each(['source', 'working', 'source-with-mark', 'proposed'] as const)(
  'honors %s for a sticky mark on an unchanged record while another record drifts',
  async (choice) => {
    const f = await makeCommandFixture(false);
    const app = await start(f);
    try {
      const setup = await app.operate('inspect');
      const list = (await app.api('review')).body;
      const [incoming, sticky] = f.artifact.classifications;
      const id = licenseReviewRowId(sticky.normalizedText);
      const ack = await app.api('review/draft', {
        kind: 'mark',
        id,
        epoch: list.epoch,
        contentRevision: list.contentRevision,
        mutationId: crypto.randomUUID(),
      });
      const selected = (
        await app.api('review/rerun', {
          kind: 'model',
          id,
          operationId: crypto.randomUUID(),
          configurationRevision: setup.configurationRevision,
          contentRevision: ack.body.contentRevision,
          estimateRevision: setup.estimateRevision,
        })
      ).body;
      const external = recordHumanLicenseDecision(
        f.artifact,
        incoming.normalizedText,
        'allowed',
        { reviewComment: 'External change' },
        'External',
        '2026-11-24T08:00:00.000Z'
      );
      await writeFile(f.input, serializeLicenseArtifact(external).bytes);
      const revision = {
        configurationRevision: setup.configurationRevision,
        contentRevision: ack.body.contentRevision,
      };
      expect((await app.api('preview', { ...revision, reviewedBy: 'Provisional' })).status).toBe(
        409
      );
      const proposal = (await app.api('source/reconcile', {})).body;
      const marked = proposal.changes.find(
        (change: { pending?: { pending: boolean } }) => change.pending?.pending
      );
      expect(marked).toMatchObject({ conflict: false, proposed: 'working' });
      expect(marked.source).toEqual(marked.working);
      const choices = choice === 'proposed' ? {} : { [marked.id]: choice };
      expect((await app.api('source/reconcile', { token: proposal.token, choices })).status).toBe(
        200
      );
      const next = (await app.api('setup')).body;
      expect(next.analysis.pendingReviews).toBe(choice === 'source' ? 0 : 1);
      expect(next).toMatchObject({
        selectedModelId: id,
        canceledModelId: null,
        paidEstimate: null,
        reassessmentSourceChange: { id, notice: sticky.exampleNotice, outcome: 'retained' },
      });
      expect(next.estimateRevision).toBeGreaterThan(selected.estimateRevision);
      const latest = (
        await app.api('ai/estimate', {
          model: next.model,
          sampleCount: next.sampleCount,
          cacheDir: next.cacheDir,
          noCache: next.noCache,
          configurationRevision: next.configurationRevision,
          contentRevision: next.contentRevision,
          loadRevision: next.loadRevision,
          estimateRevision: next.estimateRevision,
        })
      ).body.paidEstimate;
      expect(latest).toMatchObject({
        expectedUncachedRequests: next.sampleCount,
        selection: { id, kind: 'model' },
        outstanding: [{ id, human: choice !== 'source' }],
      });
      expect(latest.fingerprint).not.toBe(selected.paidEstimate.fingerprint);
      if (choice !== 'source')
        expect(latest.outstanding[0].replacementConfirmation).not.toBe(
          selected.paidEstimate.outstanding[0].replacementConfirmation
        );
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      const plan = await app.api('preview', {
        configurationRevision: next.configurationRevision,
        contentRevision: next.contentRevision,
        ...(choice === 'source' ? {} : { reviewedBy: 'Confirmed' }),
      });
      expect(plan.status).toBe(200);
      const operationId = crypto.randomUUID();
      expect(
        (
          await app.api('save', {
            configurationRevision: next.configurationRevision,
            contentRevision: next.contentRevision,
            previewToken: plan.body.preview.token,
            operationId,
            agreeToReplace: false,
          })
        ).status
      ).toBe(202);
      await expect
        .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
        .toBe('succeeded');
      const published = JSON.parse(await readFile(f.output, 'utf8')).classifications.find(
        (row: { normalizedText: string }) => row.normalizedText === sticky.normalizedText
      );
      if (choice === 'source') expect(published).toEqual(sticky);
      else
        expect(published).toMatchObject({
          status: sticky.status,
          reviewedBy: 'Confirmed',
          reviewState: 'human_reviewed',
        });
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

it.each(['inspected', 'saved'] as const)(
  'keeps reconciliation available after reverting the last mark from %s',
  async (baseline) => {
    const f = await makeCommandFixture(false);
    const app = await start(f);
    try {
      let setup = await app.operate('inspect');
      if (baseline === 'saved') {
        const plan = (
          await app.api('preview', {
            configurationRevision: 1,
            contentRevision: setup.contentRevision,
          })
        ).body;
        const operationId = crypto.randomUUID();
        expect(
          (
            await app.api('save', {
              configurationRevision: 1,
              contentRevision: setup.contentRevision,
              previewToken: plan.preview.token,
              operationId,
              agreeToReplace: false,
            })
          ).status
        ).toBe(202);
        await expect
          .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
          .toBe('succeeded');
        setup = (await app.api('setup')).body;
      }
      expect(setup.state).toBe(baseline);
      const list = (await app.api('review')).body;
      const command = { id: list.rows[0].id, epoch: list.epoch };
      const marked = await app.api('review/draft', {
        ...command,
        kind: 'mark',
        mutationId: crypto.randomUUID(),
        contentRevision: list.contentRevision,
      });
      await writeFile(f.input, `${f.sourceBytes}\n`);
      expect(
        (
          await app.api('preview', {
            configurationRevision: 1,
            contentRevision: marked.body.contentRevision,
            reviewedBy: 'Reviewer',
          })
        ).status
      ).toBe(409);
      expect(
        (
          await app.api('review/draft', {
            ...command,
            kind: 'revert',
            mutationId: crypto.randomUUID(),
            contentRevision: marked.body.contentRevision,
          })
        ).status
      ).toBe(200);
      expect((await app.api('setup')).body).toMatchObject({
        state: 'reviewing',
        sourceChanged: true,
        analysis: { pendingReviews: 0 },
      });
      const proposal = await app.api('source/reconcile', {});
      expect(proposal.status).toBe(200);
      expect(
        (await app.api('source/reconcile', { token: proposal.body.token, choices: {} })).status
      ).toBe(200);
      expect((await app.api('setup')).body.sourceChanged).toBe(false);
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);
