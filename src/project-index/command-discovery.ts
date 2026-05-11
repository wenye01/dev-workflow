import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CommandEntry,
  type MissingCommand,
  type RepositoryScan,
  type RequiredCommandKind,
} from './types.js';
import { isRecord } from '../schemas/validator.js';
import { fileExists } from './repo-scanner.js';
import { sanitizeRefId } from './util.js';

const REQUIRED_COMMANDS: readonly RequiredCommandKind[] = [
  'test',
  'lint',
  'typecheck',
  'build',
];

export async function discoverCommands(
  repoRoot: string,
  scan: RepositoryScan,
): Promise<{
  readonly commands: readonly CommandEntry[];
  readonly missing: readonly MissingCommand[];
}> {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = await readPackageJson(packageJsonPath);
  const scripts = readScripts(packageJson);
  const packageManager = await detectPackageManager(repoRoot);

  const commands: CommandEntry[] = [];

  if (scripts) {
    for (const kind of REQUIRED_COMMANDS) {
      const scriptName = findScriptForKind(kind, Object.keys(scripts));
      if (!scriptName) {
        continue;
      }

      commands.push({
        id: commandIdFor(kind, scriptName),
        kind,
        command: packageCommand(packageManager, scriptName),
        source: `package.json scripts.${scriptName}`,
        confidence: scriptName === kind ? 'high' : 'medium',
        scope: scopeForKind(kind, scan),
      });
    }
  }

  const missing = REQUIRED_COMMANDS.filter(
    (kind) => !commands.some((command) => command.kind === kind),
  ).map((kind) => ({
    kind,
    reason: scripts
      ? `No ${kind} script was found in package.json.`
      : 'No package.json scripts were available for command discovery.',
  }));

  return {
    commands,
    missing,
  };
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

function readScripts(
  packageJson: Record<string, unknown> | null,
): Record<string, string> | null {
  if (!packageJson || !isRecord(packageJson.scripts)) {
    return null;
  }

  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(packageJson.scripts)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      scripts[name] = value;
    }
  }

  return scripts;
}

async function detectPackageManager(
  repoRoot: string,
): Promise<'npm' | 'pnpm' | 'yarn'> {
  if (await fileExists(path.join(repoRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(repoRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function findScriptForKind(
  kind: RequiredCommandKind,
  scriptNames: readonly string[],
): string | null {
  if (scriptNames.includes(kind)) {
    return kind;
  }

  const fallbackPatterns: Readonly<Record<RequiredCommandKind, RegExp[]>> = {
    test: [/^test:/, /(^|:)unit($|:)/, /(^|:)spec($|:)/],
    lint: [/^lint:/, /eslint/],
    typecheck: [/^typecheck:/, /^type-check$/, /check:types/, /tsc/],
    build: [/^build:/, /compile/],
  };

  return (
    scriptNames.find((name) =>
      fallbackPatterns[kind].some((pattern) => pattern.test(name)),
    ) ?? null
  );
}

function packageCommand(
  packageManager: 'npm' | 'pnpm' | 'yarn',
  scriptName: string,
): string {
  if (packageManager === 'npm') {
    return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  }

  return `${packageManager} ${scriptName}`;
}

function commandIdFor(kind: RequiredCommandKind, scriptName: string): string {
  if (scriptName === kind) {
    return kind;
  }

  return sanitizeRefId(`${kind}-${scriptName}`, kind);
}

function scopeForKind(
  kind: RequiredCommandKind,
  scan: RepositoryScan,
): readonly string[] {
  const hasTests = scan.files.some((file) => isTestPath(file.path));
  const hasSource = scan.files.some((file) => file.path.startsWith('src/'));

  if (kind === 'test') {
    return hasTests ? ['tests/**', '**/*.test.*', '**/*.spec.*'] : ['**/*'];
  }

  if (kind === 'lint' || kind === 'typecheck') {
    return hasSource ? ['src/**', 'tests/**'] : ['**/*'];
  }

  return ['**/*'];
}

function isTestPath(relativePath: string): boolean {
  return (
    relativePath.startsWith('test/') ||
    relativePath.startsWith('tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(relativePath)
  );
}
