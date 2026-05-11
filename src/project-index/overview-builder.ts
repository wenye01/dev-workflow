import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '../core/types.js';
import { isRecord } from '../schemas/validator.js';
import {
  PROJECT_INDEX_SCHEMA_VERSIONS,
  type CommandEntry,
  type ModuleIndex,
  type RepositoryScan,
} from './types.js';
import { joinArtifactRef, titleizeIdentifier } from './util.js';

export interface ProjectOverview {
  readonly schema_version: typeof PROJECT_INDEX_SCHEMA_VERSIONS.overview;
  readonly repo: string;
  readonly generated_at: string;
  readonly summary: string;
  readonly languages: ReadonlyArray<{
    readonly name: string;
    readonly confidence: 'high' | 'medium' | 'low';
  }>;
  readonly key_directories: ReadonlyArray<{
    readonly path: string;
    readonly purpose: string;
  }>;
  readonly entrypoints: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly description: string;
  }>;
  readonly modules: ReadonlyArray<{
    readonly module_id: string;
    readonly name: string;
    readonly summary: string;
    readonly module_ref: ArtifactRef;
  }>;
  readonly test_strategy: {
    readonly summary: string;
    readonly command_refs: readonly string[];
  };
  readonly build_strategy: {
    readonly summary: string;
    readonly command_refs: readonly string[];
  };
}

export async function buildOverview(options: {
  readonly repoRoot: string;
  readonly repo: string;
  readonly generatedAt: string;
  readonly scan: RepositoryScan;
  readonly commands: readonly CommandEntry[];
  readonly modules: readonly ModuleIndex[];
  readonly outRef: ArtifactRef;
}): Promise<ProjectOverview> {
  const summary = await inferSummary(options.repoRoot, options.scan);
  const testCommands = options.commands
    .filter((command) => command.kind === 'test')
    .map((command) => command.id);
  const buildCommands = options.commands
    .filter((command) => ['build', 'typecheck'].includes(command.kind))
    .map((command) => command.id);

  return {
    schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.overview,
    repo: options.repo,
    generated_at: options.generatedAt,
    summary,
    languages: inferLanguages(options.scan),
    key_directories: inferKeyDirectories(options.scan),
    entrypoints: inferEntrypoints(options.scan),
    modules: options.modules.map((module) => ({
      module_id: module.module_id,
      name: module.name,
      summary: module.summary,
      module_ref: joinArtifactRef(
        options.outRef,
        'modules',
        `${module.module_id}.json`,
      ),
    })),
    test_strategy: {
      summary:
        testCommands.length > 0
          ? 'Run discovered test commands before accepting changes.'
          : 'No test command was discovered; this is recorded in the build report.',
      command_refs: testCommands,
    },
    build_strategy: {
      summary:
        buildCommands.length > 0
          ? 'Run discovered build or typecheck commands for integration checks.'
          : 'No build or typecheck command was discovered; this is recorded in the build report.',
      command_refs: buildCommands,
    },
  };
}

export function renderOverviewMarkdown(overview: ProjectOverview): string {
  const lines = [
    '# Project Overview',
    '',
    '<!-- Generated from Project Index JSON. This Markdown view is not authoritative state. -->',
    '',
    overview.summary,
    '',
    '## Languages',
    '',
    ...overview.languages.map(
      (language) => `- ${language.name} (${language.confidence})`,
    ),
    '',
    '## Key Directories',
    '',
    ...overview.key_directories.map(
      (directory) => `- ${directory.path}: ${directory.purpose}`,
    ),
    '',
    '## Modules',
    '',
    ...overview.modules.map((module) => `- ${module.name}: ${module.summary}`),
    '',
    '## Verification',
    '',
    `- Tests: ${overview.test_strategy.summary}`,
    `- Build: ${overview.build_strategy.summary}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

async function inferSummary(
  repoRoot: string,
  scan: RepositoryScan,
): Promise<string> {
  const packageJson = await readPackageJson(
    path.join(repoRoot, 'package.json'),
  );
  const packageName =
    typeof packageJson?.name === 'string' ? packageJson.name : null;
  const description =
    typeof packageJson?.description === 'string'
      ? packageJson.description
      : null;

  if (packageName && description) {
    return `${packageName}: ${description}`;
  }

  const readme = scan.files.find((file) =>
    /^readme\.(md|mdx|rst)$/i.test(path.posix.basename(file.path)),
  );
  if (readme) {
    const content = await readFile(readme.absolute_path, 'utf8');
    const title = /^#\s+(.+?)\s*$/m.exec(content)?.[1];
    if (title) {
      return `${title.trim()} project indexed from repository files.`;
    }
  }

  return `${path.basename(repoRoot)} project indexed from repository files.`;
}

async function readPackageJson(
  packageJsonPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferLanguages(scan: RepositoryScan): ReadonlyArray<{
  readonly name: string;
  readonly confidence: 'high' | 'medium' | 'low';
}> {
  const counts = new Map<string, number>();
  for (const file of scan.files) {
    if (file.language) {
      counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
    }
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const languages = [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 8)
    .map(([name, count]) => ({
      name,
      confidence: confidenceFor(count, total),
    }));

  return languages.length > 0
    ? languages
    : [{ name: 'Unknown', confidence: 'low' as const }];
}

function confidenceFor(
  count: number,
  total: number,
): 'high' | 'medium' | 'low' {
  if (total === 0) {
    return 'low';
  }

  const ratio = count / total;
  if (ratio >= 0.4 || count >= 4) {
    return 'high';
  }
  if (ratio >= 0.2 || count >= 2) {
    return 'medium';
  }
  return 'low';
}

function inferKeyDirectories(
  scan: RepositoryScan,
): ReadonlyArray<{ readonly path: string; readonly purpose: string }> {
  const topLevelDirs = scan.entries
    .filter((entry) => entry.kind === 'directory' && !entry.path.includes('/'))
    .map((entry) => entry.path);

  const directories = topLevelDirs
    .map((directory) => ({
      path: directory,
      purpose: purposeForDirectory(directory),
    }))
    .filter((directory) => directory.purpose)
    .slice(0, 10);

  return directories.length > 0
    ? directories
    : [{ path: '.', purpose: 'Repository root.' }];
}

function purposeForDirectory(directory: string): string {
  const known: Readonly<Record<string, string>> = {
    src: 'Runtime source.',
    test: 'Automated tests.',
    tests: 'Automated tests.',
    docs: 'Project documentation.',
    scripts: 'Developer automation scripts.',
    schemas: 'JSON Schema contracts.',
    fixtures: 'Test fixtures.',
    packages: 'Workspace packages.',
    apps: 'Application packages.',
  };

  return known[directory] ?? `${titleizeIdentifier(directory)} files.`;
}

function inferEntrypoints(scan: RepositoryScan): ReadonlyArray<{
  readonly path: string;
  readonly kind: string;
  readonly description: string;
}> {
  const candidates = [
    ['package.json', 'package', 'Package metadata and script entrypoint.'],
    ['src/index.ts', 'source', 'TypeScript source entrypoint.'],
    ['src/index.tsx', 'source', 'TypeScript JSX source entrypoint.'],
    ['src/cli/index.ts', 'cli', 'CLI source entrypoint.'],
    ['index.ts', 'source', 'Root TypeScript entrypoint.'],
    ['index.js', 'source', 'Root JavaScript entrypoint.'],
  ] as const;

  const files = new Set(scan.files.map((file) => file.path));
  const entrypoints = candidates
    .filter(([file]) => files.has(file))
    .map(([file, kind, description]) => ({
      path: file,
      kind,
      description,
    }));

  if (entrypoints.length > 0) {
    return entrypoints;
  }

  const firstSource = scan.files.find((file) =>
    /\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(file.path),
  );

  return firstSource
    ? [
        {
          path: firstSource.path,
          kind: 'source',
          description: 'First discovered source file.',
        },
      ]
    : [
        {
          path: scan.files[0]?.path ?? 'README.md',
          kind: 'file',
          description: 'First discovered repository file.',
        },
      ];
}
