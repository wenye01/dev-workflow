import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GitSha } from '../core/types.js';
import { asGitSha } from '../core/types.js';
import { ProjectIndexError } from './util.js';

const execFileAsync = promisify(execFile);

export interface ProjectIndexRepositoryInfo {
  readonly repoRoot: string;
  readonly head: GitSha;
  readonly currentBranch: string | null;
}

export async function resolveGitRepository(
  repoPath: string,
): Promise<ProjectIndexRepositoryInfo> {
  const resolvedRepo = path.resolve(repoPath);

  try {
    const stats = await stat(resolvedRepo);
    if (!stats.isDirectory()) {
      throw new ProjectIndexError({
        code: 'AGENTFLOW_REPO_NOT_DIRECTORY',
        message: `Repository path is not a directory: ${resolvedRepo}`,
      });
    }
  } catch (error) {
    if (error instanceof ProjectIndexError) {
      throw error;
    }

    throw new ProjectIndexError({
      code: 'AGENTFLOW_REPO_NOT_FOUND',
      message: `Repository path is not readable: ${resolvedRepo}`,
      cause: error,
    });
  }

  try {
    const inside = await git(resolvedRepo, [
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (inside.trim() !== 'true') {
      throw new Error('not inside a git work tree');
    }

    const [repoRoot, head, branch] = await Promise.all([
      git(resolvedRepo, ['rev-parse', '--show-toplevel']),
      git(resolvedRepo, ['rev-parse', 'HEAD']),
      git(resolvedRepo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);

    return {
      repoRoot: repoRoot.trim(),
      head: asGitSha(head.trim()),
      currentBranch: branch.trim() === 'HEAD' ? null : branch.trim(),
    };
  } catch (error) {
    throw new ProjectIndexError({
      code: 'AGENTFLOW_NOT_GIT_REPOSITORY',
      message: `Path is not a git repository: ${resolvedRepo}`,
      cause: error,
    });
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout;
}
