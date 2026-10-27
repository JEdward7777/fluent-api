import { describe, expect, it } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';

const required = ['--source=json', '--destination=database'];
describe('developer command configuration before analysis', () => {
  it.each([
    '--source=other',
    '--destination=other',
    '--model=openrouter:other',
    '--model=google:a --model=google:b',
    '--sample-count=1',
    '--sample-count=2.1',
    '--report-formats=pdf',
    '--yes --open-report --report-formats=html',
  ])('rejects invalid or unsupported flags: %s', (flags) => {
    expect(() => parseLicenseCommandOptions([...required, ...flags.split(' ')], false)).toThrow();
  });
  it('requires independent source/destination for unattended runs and permits prompting only with a terminal', () => {
    expect(() => parseLicenseCommandOptions([], false)).toThrow('both');
    expect(() => parseLicenseCommandOptions(['--yes'], true)).toThrow('both');
    expect(parseLicenseCommandOptions([], true)).toMatchObject({
      options: { source: undefined, destination: undefined },
    });
  });
  it('accepts uncapped samples and deduplicates report selections with explicit interactive HTML open', () => {
    expect(
      parseLicenseCommandOptions(
        [...required, '--sample-count=10001', '--report-formats=html,html', '--open-report'],
        true
      )
    ).toMatchObject({
      options: { sampleCount: 10001, reportFormats: 'html,html', openReport: true },
    });
  });
});
