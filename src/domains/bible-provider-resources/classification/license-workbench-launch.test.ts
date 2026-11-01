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

  it('rejects practice until its offline capability exists', () => {
    expect(() => parseLicenseWorkbenchLaunch(['--practice'], true)).toThrow('being prepared');
  });
});
