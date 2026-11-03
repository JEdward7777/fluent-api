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

  it('requires an exact loopback CodeServer proxy URL and matching explicit port', () => {
    const args = ['--ui=web', '--port=8766', '--local-proxy-url=http://localhost:8454/proxy/8766/'];
    expect(parseLicenseWorkbenchLaunch(args, false)).toMatchObject({
      kind: 'web',
      port: 8766,
      localProxyUrl: 'http://localhost:8454/proxy/8766/',
    });
    for (const url of [
      'https://localhost:8454/proxy/8766/',
      'http://evil.example:8454/proxy/8766/',
      'http://localhost:8454/proxy/8767/',
      'http://localhost:8454/proxy/8766/?x=1',
      'http://localhost:8454/proxy/8766/#secret',
      'http://user@localhost:8454/proxy/8766/',
      'http://localhost:8454/other/8766/',
    ])
      expect(() =>
        parseLicenseWorkbenchLaunch(args.slice(0, 2).concat(`--local-proxy-url=${url}`), false)
      ).toThrow('local-proxy-url');
    expect(() =>
      parseLicenseWorkbenchLaunch(
        ['--ui=web', '--local-proxy-url=http://localhost:8454/proxy/8766/'],
        false
      )
    ).toThrow('local-proxy-url');
    expect(() =>
      parseLicenseWorkbenchLaunch(
        ['--ui=cli', '--local-proxy-url=http://localhost:8454/proxy/8766/'],
        false
      )
    ).toThrow('browser mode');
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
