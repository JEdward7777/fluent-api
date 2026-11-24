import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const LICENSE_REVIEWER_REPORT_ROOT = '/reports';

export interface LicenseReviewerContainer {
  hostReports?: string;
  engine?: 'Docker' | 'Podman';
}

export async function describeLicenseReportPath(
  path: string,
  container: LicenseReviewerContainer,
  inspected?: { parent: string | undefined }
) {
  const hostRoot = container.hostReports;
  if (hostRoot) {
    const parent = inspected
      ? inspected.parent
      : await realpath(dirname(path)).catch(() => undefined);
    if (parent) {
      // The writer replaces the final directory entry, even when it is a symlink.
      const suffix = relative(LICENSE_REVIEWER_REPORT_ROOT, join(parent, basename(path)));
      if (suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
        const separator = hostRoot.includes('\\') ? '\\' : '/';
        const hostPath = [hostRoot.replace(/[\\/]+$/, ''), ...suffix.split(sep)].join(separator);
        return `${container.engine ?? 'Docker'} host path: ${hostPath}`;
      }
    }
  }
  return `Container path: ${path}`;
}

export function licenseReviewerContainerArgs(args: string[], environment: NodeJS.ProcessEnv) {
  const ui = environment.LICENSE_REVIEWER_UI ?? 'web';
  if (ui !== 'web' && ui !== 'cli') throw new Error('Select --ui=web or --ui=cli');
  if (args.some((arg) => /^--(?:ui|port|local-proxy-url|open-report)(?:=|$)/.test(arg)))
    throw new Error(
      'Set UI and port in the container launcher. The container cannot open local applications or use a CodeServer proxy.'
    );
  return [
    `--ui=${ui}`,
    ...(ui === 'web' ? [`--port=${environment.LICENSE_REVIEWER_PORT ?? '8766'}`] : []),
    ...(args.includes('--practice') ? [] : [`--report-dir=${LICENSE_REVIEWER_REPORT_ROOT}`]),
    ...args,
  ];
}
