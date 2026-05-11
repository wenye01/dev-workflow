import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ProjectIndexError } from './util.js';

export type ProjectIndexShowName =
  | 'manifest'
  | 'overview'
  | 'documents'
  | 'commands'
  | 'modules'
  | 'tree';

export async function readProjectIndexView(
  indexDir: string,
  name: ProjectIndexShowName,
): Promise<unknown> {
  const resolvedIndexDir = path.resolve(indexDir);

  if (name === 'modules') {
    return {
      name: 'modules',
      modules: await readModules(path.join(resolvedIndexDir, 'modules')),
    };
  }

  const fileByName: Readonly<
    Record<Exclude<ProjectIndexShowName, 'modules'>, string>
  > = {
    manifest: 'manifest.json',
    overview: 'overview.json',
    documents: path.join('documents', 'index.json'),
    commands: 'commands.json',
    tree: 'repo-tree.json',
  };

  return readJson(path.join(resolvedIndexDir, fileByName[name]));
}

export function parseProjectIndexShowName(value: string): ProjectIndexShowName {
  if (
    value === 'manifest' ||
    value === 'overview' ||
    value === 'documents' ||
    value === 'commands' ||
    value === 'modules' ||
    value === 'tree'
  ) {
    return value;
  }

  throw new ProjectIndexError({
    code: 'AGENTFLOW_PROJECT_INDEX_UNKNOWN_VIEW',
    message:
      'Project Index show name must be one of manifest, overview, documents, commands, modules, or tree.',
  });
}

async function readModules(modulesDir: string): Promise<readonly unknown[]> {
  let files;
  try {
    files = await readdir(modulesDir);
  } catch (error) {
    throw new ProjectIndexError({
      code: 'AGENTFLOW_PROJECT_INDEX_READ_FAILED',
      message: `Could not read Project Index modules directory: ${modulesDir}`,
      cause: error,
    });
  }

  return Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readJson(path.join(modulesDir, file))),
  );
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectIndexError({
      code: 'AGENTFLOW_PROJECT_INDEX_READ_FAILED',
      message: `Could not read Project Index artifact: ${filePath}`,
      cause: error,
    });
  }
}
