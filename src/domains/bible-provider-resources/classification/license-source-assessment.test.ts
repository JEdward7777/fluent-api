import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { createRequestCache } from '@/lib/llm/request-cache';

import { createLicenseArtifact, serializeLicenseArtifact } from '../license-artifact';
import { buildLicenseSampleRequest } from '../license-model-contract';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import { LicenseWorkflow } from './license-workflow';

it.each([
  { cached: true, explicit: true },
  { cached: true, explicit: false },
  { cached: false, explicit: true },
  { cached: false, explicit: false },
])(
  'assesses accepted notice wording after reconciliation (cached $cached, explicit $explicit)',
  async ({ cached, explicit }) => {
    const f = await makeCommandFixture(false);
    const row = f.artifact.classifications[2];
    const id = licenseKeyDigest(row.normalizedText);
    const options = { ...f.options, rerunModel: explicit ? [] : [id] };
    const original = row.exampleNotice!;
    const changed = `Copyright 2025 ${original.toUpperCase()}`;
    const fresh = createLicenseArtifact({
      ...f.artifact,
      classifications: f.artifact.classifications.map((r) =>
        r === row ? { ...r, exampleNotice: changed } : r
      ),
      catalog: f.artifact.catalog.map((r) =>
        r.rawNotice === original ? { ...r, rawNotice: changed } : r
      ),
    });
    const workflow = new LicenseWorkflow(options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      await workflow.inspect(1);
      await writeFile(f.input, serializeLicenseArtifact(fresh).bytes);
      await expect(workflow.preview(1, workflow.status.contentRevision)).rejects.toThrow(
        'Inspected inputs changed'
      );
      const proposal = await workflow.reconcileSource();
      if (!proposal.changes) throw new Error('Missing source proposal');
      expect(proposal.changes).toHaveLength(2);
      await workflow.reconcileSource({
        token: proposal.token,
        choices: Object.fromEntries(proposal.changes.map((item) => [item.id, 'working'])),
      });
      await workflow.configureLoadedSettings(options, false, true);
      if (cached) {
        const cache = createRequestCache(options.cacheDir);
        for (let index = 1; index <= options.sampleCount; index++)
          await cache.write(
            buildLicenseSampleRequest(
              original,
              'google',
              options.model.replace(/^google:/, ''),
              index
            ),
            '{"rationale":"Working cache","decision":"allowed"}'
          );
      }
      const estimate = await workflow.prepareFree(
        workflow.status.contentRevision,
        explicit ? { id, kind: 'model' } : undefined
      );
      if (cached) {
        expect(estimate.expectedUncachedRequests).toBe(0);
        expect(f.dependencies.transport).not.toHaveBeenCalled();
      } else {
        expect(estimate.outstanding).toMatchObject([{ id, exampleNotice: original }]);
        await workflow.runPaid(
          {
            maximumRequests: estimate.expectedUncachedRequests,
            fingerprint: estimate.fingerprint,
            replacementConfirmations: [],
          },
          { attempts: 0, completedRows: 0 }
        );
        expect(f.dependencies.transport).toHaveBeenCalledTimes(options.sampleCount);
      }
      const revised = workflow.analyzed!.artifact.classifications.find(
        (r) => r.normalizedText === row.normalizedText
      )!;
      expect(revised.exampleNotice).toBe(original);
      expect(revised.samples).toHaveLength(options.sampleCount);
      for (const sample of revised.samples)
        expect(sample.request.messages.at(-1)?.content).toContain(JSON.stringify(original));
      expect(workflow.inspectedSource?.inputBytes).toBe(serializeLicenseArtifact(fresh).bytes);
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

it.each([
  { kind: 'rule', keep: true },
  { kind: 'rule', keep: false },
  { kind: 'model', keep: true },
  { kind: 'model', keep: false },
] as const)(
  'recovers a physically removed launch $kind selection (keep $keep)',
  async ({ kind, keep }) => {
    const f = await makeCommandFixture(false);
    const row = f.artifact.classifications[kind === 'rule' ? 0 : 2];
    const id = licenseKeyDigest(row.normalizedText);
    const options = {
      ...f.options,
      ...(kind === 'rule' ? { rerunRule: [id] } : { rerunModel: [id] }),
    };
    const workflow = new LicenseWorkflow(options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      await workflow.inspect(1);
      const fresh = createLicenseArtifact({
        ...f.artifact,
        classifications: f.artifact.classifications.filter((r) => r !== row),
        catalog: f.artifact.catalog.filter((r) => r.rawNotice !== row.exampleNotice),
      });
      await writeFile(f.input, serializeLicenseArtifact(fresh).bytes);
      await expect(workflow.preview(1, workflow.status.contentRevision)).rejects.toThrow(
        'Inspected inputs changed'
      );
      const proposal = await workflow.reconcileSource();
      if (!proposal.changes) throw new Error('Missing source proposal');
      await workflow.reconcileSource({
        token: proposal.token,
        choices: Object.fromEntries(
          proposal.changes.map((c) => [c.id, keep ? 'working' : 'source'])
        ),
      });
      const revision = workflow.status.contentRevision;
      const estimate = await workflow.prepareFree(revision);
      const current = workflow.analyzed!.artifact.classifications.find(
        (r) => r.normalizedText === row.normalizedText
      );
      if (keep) {
        expect(
          workflow.inspectedSource!.preflight.rows.find(
            (r) => r.normalizedText === row.normalizedText
          )?.action
        ).toBe(kind);
        if (kind === 'rule') expect(workflow.status.contentRevision).toBe(revision);
        else expect(estimate.outstanding).toMatchObject([{ id, exampleNotice: row.exampleNotice }]);
        expect(current).toBeDefined();
      } else {
        expect(current).toBeUndefined();
        expect(estimate.outstanding).toEqual([]);
        await expect(workflow.prepareFree(revision, { id, kind })).rejects.toThrow(
          'No exact normalized classification'
        );
      }
      expect(f.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

it('does not reassess a retained unavailable notice from rejected source evidence', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications[2];
  const id = licenseKeyDigest(row.normalizedText);
  const absent = createLicenseArtifact({
    ...f.artifact,
    classifications: f.artifact.classifications.map((r) =>
      r === row ? { ...r, exampleNotice: null } : r
    ),
    catalog: f.artifact.catalog.filter((r) => r.rawNotice !== row.exampleNotice),
  });
  await writeFile(f.input, serializeLicenseArtifact(absent).bytes);
  const workflow = new LicenseWorkflow(f.options, {
    ...f.dependencies,
    destinationDatabase: f.dependencies.database,
  });
  try {
    await workflow.inspect(1);
    await writeFile(f.input, f.sourceBytes);
    await expect(workflow.preview(1, 1)).rejects.toThrow('Inspected inputs changed');
    const proposal = await workflow.reconcileSource();
    if (!proposal.changes) throw new Error('Missing source proposal');
    await workflow.reconcileSource({
      token: proposal.token,
      choices: Object.fromEntries(proposal.changes.map((c) => [c.id, 'working'])),
    });
    const preflight = workflow.inspectedSource!.preflight.rows.find(
      (r) => r.normalizedText === row.normalizedText
    );
    expect(preflight).toMatchObject({
      action: 'retain',
      exampleNotice: null,
      reason: 'original notice unavailable',
    });
    expect((await workflow.prepareFree(2)).outstanding).toEqual([]);
    await expect(workflow.prepareFree(2, { id, kind: 'model' })).rejects.toThrow(
      'original notice is required'
    );
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it('uses the accepted unknown database decision for bulk paid eligibility after rejecting an external resolved decision', async () => {
  const f = await makeCommandFixture(false);
  const row = f.artifact.classifications[2];
  f.snapshot.context.resources = f.snapshot.context.resources.filter(
    (r) => r.rawNotice === row.exampleNotice
  );
  const workflow = new LicenseWorkflow(
    { ...f.options, source: 'database' },
    { ...f.dependencies, destinationDatabase: f.dependencies.database }
  );
  try {
    await workflow.inspect(1);
    expect(workflow.paidEstimate!.outstanding).toHaveLength(1);
    f.snapshot.classifications = [
      {
        normalizedText: row.normalizedText,
        exampleNotice: row.exampleNotice!,
        status: 'allowed',
        rationale: 'Resolved by source',
        classifiedBy: null,
        reviewedAt: null,
        reviewState: 'unreviewed',
      },
    ];
    await expect(workflow.preview(1, 1)).rejects.toThrow('Inspected inputs changed');
    const proposal = await workflow.reconcileSource();
    if (!proposal.changes) throw new Error('Missing source proposal');
    await workflow.reconcileSource({
      token: proposal.token,
      choices: Object.fromEntries(proposal.changes.map((c) => [c.id, 'working'])),
    });
    expect(workflow.inspectedSource!.database!.classifications[0].status).toBe('allowed');
    const estimate = await workflow.prepareFree(workflow.status.contentRevision);
    expect(workflow.inspectedSource!.preflight.rows).toMatchObject([
      { action: 'model', reason: 'unreviewed unknown database key' },
    ]);
    expect(estimate.outstanding).toMatchObject([
      { id: licenseKeyDigest(row.normalizedText), exampleNotice: row.exampleNotice },
    ]);
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it.each([
  { kind: 'model', replace: false },
  { kind: 'rule', replace: false },
  { kind: 'model', replace: true },
  { kind: 'rule', replace: true },
] as const)(
  'retains or invalidates the exact completed launch $kind basis (replace $replace)',
  async ({ kind, replace }) => {
    const f = await makeCommandFixture(false);
    const selected = f.artifact.classifications[kind === 'model' ? 2 : 0];
    const id = licenseKeyDigest(selected.normalizedText);
    const options = {
      ...f.options,
      noCache: true,
      ...(kind === 'rule' ? { rerunRule: [id] } : { rerunModel: [id] }),
    };
    const workflow = new LicenseWorkflow(options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      await workflow.inspect(1);
      const estimate = await workflow.prepareFree(workflow.status.contentRevision, { id, kind });
      if (kind === 'model')
        await workflow.runPaid(
          {
            maximumRequests: estimate.expectedUncachedRequests,
            fingerprint: estimate.fingerprint,
            replacementConfirmations: [],
          },
          { attempts: 0, completedRows: 0 }
        );
      const completed = workflow.analyzed!.artifact.classifications.find(
        (r) => r.normalizedText === selected.normalizedText
      )!;
      const other = f.artifact.classifications[1];
      const external = createLicenseArtifact({
        ...f.artifact,
        classifications: f.artifact.classifications.map((row) =>
          row === other || (replace && row === selected)
            ? { ...row, auditTag: 'external revision' }
            : row
        ),
      });
      await writeFile(f.input, serializeLicenseArtifact(external).bytes);
      await expect(workflow.preview(1, workflow.status.contentRevision)).rejects.toThrow(
        'Inspected inputs changed'
      );
      const proposal = await workflow.reconcileSource();
      if (!proposal.changes) throw new Error('Expected source proposal');
      const conflict = proposal.changes.find((c) => c.conflict);
      expect(Boolean(conflict)).toBe(replace);
      await workflow.reconcileSource({
        token: proposal.token,
        choices: conflict ? { [conflict.id]: 'source' } : {},
      });
      const revision = workflow.status.contentRevision;
      const next = await workflow.prepareFree(revision);
      expect(f.dependencies.transport).toHaveBeenCalledTimes(
        kind === 'model' ? options.sampleCount : 0
      );
      expect(next.expectedUncachedRequests).toBe(
        replace && kind === 'model' ? options.sampleCount : 0
      );
      expect(workflow.status.contentRevision).toBe(revision + Number(replace && kind === 'rule'));
      if (!replace)
        expect(
          workflow.analyzed!.artifact.classifications.find(
            (r) => r.normalizedText === selected.normalizedText
          )
        ).toEqual(completed);
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);
