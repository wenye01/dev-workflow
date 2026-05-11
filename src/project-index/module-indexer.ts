import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../schemas/validator.js';
import {
  PROJECT_INDEX_SCHEMA_VERSIONS,
  type CommandEntry,
  type ModuleDependency,
  type ModuleIndex,
  type RepositoryScan,
  type ScannedFile,
} from './types.js';
import { sanitizeRefId, titleizeIdentifier } from './util.js';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.go',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.rs',
  '.ts',
  '.tsx',
]);

export async function buildModuleIndexes(
  repoRoot: string,
  scan: RepositoryScan,
  commands: readonly CommandEntry[],
): Promise<readonly ModuleIndex[]> {
  const sourceFiles = scan.files.filter((file) => isSourceFile(file.path));
  const testFiles = scan.files.filter((file) => isTestFile(file.path));
  const groups = groupSourceFiles(sourceFiles, testFiles);
  const dependencies = await packageDependencies(repoRoot);
  const relatedCommands = commands
    .filter((command) =>
      ['test', 'lint', 'typecheck', 'build'].includes(command.kind),
    )
    .map((command) => command.id);

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, group]) => {
      const name = moduleId === 'root' ? 'Root' : titleizeIdentifier(moduleId);
      const boundaries = boundaryPaths(moduleId, group);
      const entrypoints = selectEntrypoints(group.sourceFiles);
      const moduleDependencies =
        dependencies.length > 0
          ? dependencies
          : [
              {
                kind: 'runtime',
                target: 'node',
                summary: 'Runs in the Node.js runtime.',
              } satisfies ModuleDependency,
            ];

      return {
        schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.module,
        module_id: moduleId,
        name,
        summary: `${name} module inferred from ${boundaries.join(', ')}.`,
        boundaries: {
          paths: boundaries,
        },
        entrypoints,
        test_files: group.testFiles.map((file) => file.path).sort(),
        dependencies: moduleDependencies,
        related_commands: relatedCommands,
      };
    });
}

function groupSourceFiles(
  sourceFiles: readonly ScannedFile[],
  testFiles: readonly ScannedFile[],
): Map<string, { sourceFiles: ScannedFile[]; testFiles: ScannedFile[] }> {
  const groups = new Map<
    string,
    { sourceFiles: ScannedFile[]; testFiles: ScannedFile[] }
  >();

  for (const sourceFile of sourceFiles) {
    const moduleId = moduleIdForSource(sourceFile.path);
    getGroup(groups, moduleId).sourceFiles.push(sourceFile);
  }

  if (groups.size === 0) {
    getGroup(groups, 'root');
  }

  for (const testFile of testFiles) {
    const moduleId = moduleIdForTest(testFile.path);
    const targetGroup = groups.has(moduleId) ? moduleId : 'root';
    getGroup(groups, targetGroup).testFiles.push(testFile);
  }

  return groups;
}

function getGroup(
  groups: Map<string, { sourceFiles: ScannedFile[]; testFiles: ScannedFile[] }>,
  moduleId: string,
): { sourceFiles: ScannedFile[]; testFiles: ScannedFile[] } {
  let group = groups.get(moduleId);
  if (!group) {
    group = { sourceFiles: [], testFiles: [] };
    groups.set(moduleId, group);
  }
  return group;
}

function moduleIdForSource(relativePath: string): string {
  const segments = relativePath.split('/');
  if (segments[0] === 'src' && segments[1]) {
    return sanitizeRefId(segments[1], 'src');
  }

  return sanitizeRefId(segments[0] ?? 'root', 'root');
}

function moduleIdForTest(relativePath: string): string {
  const segments = relativePath.split('/');
  if ((segments[0] === 'test' || segments[0] === 'tests') && segments[1]) {
    return sanitizeRefId(segments[1], 'root');
  }

  return 'root';
}

function boundaryPaths(
  moduleId: string,
  group: {
    sourceFiles: readonly ScannedFile[];
    testFiles: readonly ScannedFile[];
  },
): readonly string[] {
  if (moduleId === 'root') {
    const roots = new Set(
      [...group.sourceFiles, ...group.testFiles].map(
        (file) => `${file.path.split('/')[0] ?? file.path}/**`,
      ),
    );
    return roots.size > 0 ? [...roots].sort() : ['**'];
  }

  const paths = new Set<string>();
  if (
    group.sourceFiles.some((file) => file.path.startsWith(`src/${moduleId}/`))
  ) {
    paths.add(`src/${moduleId}/**`);
  }
  if (
    group.testFiles.some(
      (file) =>
        file.path.startsWith(`tests/${moduleId}/`) ||
        file.path.startsWith(`test/${moduleId}/`),
    )
  ) {
    paths.add(`tests/${moduleId}/**`);
    paths.add(`test/${moduleId}/**`);
  }

  if (paths.size === 0) {
    for (const file of [...group.sourceFiles, ...group.testFiles]) {
      paths.add(file.path);
    }
  }

  return [...paths].sort();
}

function selectEntrypoints(
  sourceFiles: readonly ScannedFile[],
): readonly string[] {
  const preferred = sourceFiles
    .filter((file) => /(^|\/)(index|main|cli)\.[cm]?[jt]sx?$/.test(file.path))
    .map((file) => file.path);

  if (preferred.length > 0) {
    return preferred.sort().slice(0, 5);
  }

  return sourceFiles
    .map((file) => file.path)
    .sort()
    .slice(0, 5);
}

async function packageDependencies(
  repoRoot: string,
): Promise<readonly ModuleDependency[]> {
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as unknown;
    if (!isRecord(packageJson)) {
      return [];
    }

    const dependencies: ModuleDependency[] = [];
    for (const key of ['dependencies', 'devDependencies']) {
      const value = packageJson[key];
      if (!isRecord(value)) {
        continue;
      }

      for (const packageName of Object.keys(value).sort().slice(0, 10)) {
        dependencies.push({
          kind: 'package',
          target: packageName,
          summary: `${packageName} is declared in package.json ${key}.`,
        });
      }
    }

    return dependencies.slice(0, 10);
  } catch {
    return [];
  }
}

function isSourceFile(relativePath: string): boolean {
  if (isTestFile(relativePath)) {
    return false;
  }

  return SOURCE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

function isTestFile(relativePath: string): boolean {
  return (
    relativePath.startsWith('test/') ||
    relativePath.startsWith('tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(relativePath)
  );
}
