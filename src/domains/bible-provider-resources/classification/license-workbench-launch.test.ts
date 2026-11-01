import { describe, expect, it } from 'vitest';

import { parseLicenseWorkbenchLaunch } from './license-workbench-launch';

describe('license workbench launch', () => {
  it('gives help precedence without validating unrelated flags', () => {
    expect(parseLicenseWorkbenchLaunch(['--ui=bad', '--source=bad', '--help'], false)).toEqual({
      kind: 'help',
    });
  });

  it('selects web only for an interactive default or explicit web choice', () => {
    expect(parseLicenseWorkbenchLaunch(['--source=json'], true)).toMatchObject({
      kind: 'web',
      port: 0,
    });
    expect(parseLicenseWorkbenchLaunch(['--ui=web', '--source=json'], false)).toMatchObject({
      kind: 'web',
      port: 0,
    });
    expect(parseLicenseWorkbenchLaunch(['--ui', 'web', '--port', '8766'], false)).toMatchObject({
      kind: 'web',
      port: 8766,
    });
    expect(() => parseLicenseWorkbenchLaunch([], false)).toThrow('Select both');
  });

  it('keeps automation and explicit CLI on the CLI path', () => {
    expect(
      parseLicenseWorkbenchLaunch(['--source=json', '--destination=json', '--yes'], true)
    ).toMatchObject({ kind: 'cli' });
    expect(
      parseLicenseWorkbenchLaunch(['--ui=cli', '--source=json', '--destination=json'], true)
    ).toMatchObject({ kind: 'cli' });
    expect(() => parseLicenseWorkbenchLaunch(['--ui=web', '--yes'], false)).toThrow('use --ui=cli');
  });

  it('selects explicit browser practice and rejects automation, real targets and reviewer flags', () => {
    expect(parseLicenseWorkbenchLaunch(['--practice'], true)).toMatchObject({
      kind: 'web',
      practice: true,
      options: { input: '' },
    });
    expect(
      parseLicenseWorkbenchLaunch(['--practice', '--ui=web', '--input=/tmp/saved.json'], false)
    ).toMatchObject({ kind: 'web', practice: true, options: { input: '/tmp/saved.json' } });
    expect(() => parseLicenseWorkbenchLaunch(['--practice'], false)).toThrow(
      'requires explicit --ui=web'
    );
    for (const flag of [
      '--ui=cli',
      '--yes',
      '--plan-only',
      '--source=json',
      '--destination=json',
      '--output=/tmp/real.json',
      '--cache-dir=/tmp/cache',
      '--report-dir=/tmp/reports',
      '--reviewer=Alice',
      '--review-reason=done',
      '--force',
    ])
      expect(() => parseLicenseWorkbenchLaunch(['--practice', '--ui=web', flag], false)).toThrow(
        'Practice accepts only'
      );
  });
});
