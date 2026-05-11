import { execFile } from 'node:child_process';
import { lstat, opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  type RepositoryScan,
  type ScannedFile,
  type SkipEntry,
  type TreeEntry,
} from './types.js';
import { relativePosix, sha256Buffer, toPosixPath } from './util.js';

const execFileAsync = promisify(execFile);
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 4096;

const DEPENDENCY_DIRECTORIES = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'vendor',
]);

const INTERNAL_DIRECTORIES = new Set([
  '.git',
  '.agentflow',
  '.agentflow-worktrees',
]);

const GENERATED_DIRECTORIES = new Set([
  'coverage',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

export async function scanRepository(
  repoRoot: string,
): Promise<RepositoryScan> {
  const entries: TreeEntry[] = [];
  const files: ScannedFile[] = [];
  const skipped: SkipEntry[] = [];

  await scanDirectory({
    repoRoot,
    directory: repoRoot,
    entries,
    files,
    skipped,
  });

  return {
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function scanDirectory(options: {
  readonly repoRoot: string;
  readonly directory: string;
  readonly entries: TreeEntry[];
  readonly files: ScannedFile[];
  readonly skipped: SkipEntry[];
}): Promise<void> {
  let dir;
  try {
    dir = await opendir(options.directory);
  } catch (error) {
    options.skipped.push({
      path: relativePosix(options.repoRoot, options.directory),
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for await (const dirent of dir) {
    const absolutePath = path.join(options.directory, dirent.name);
    const relativePath = relativePosix(options.repoRoot, absolutePath);

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      options.skipped.push({
        path: relativePath,
        reason: 'unreadable',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const staticSkip = classifyStaticSkip(relativePath, dirent.isDirectory());
    if (staticSkip) {
      options.skipped.push(staticSkip);
      continue;
    }

    if (
      await isGitIgnored(options.repoRoot, relativePath, dirent.isDirectory())
    ) {
      options.skipped.push({
        path: relativePath,
        reason: 'gitignored',
        detail: 'Matched repository ignore rules.',
      });
      continue;
    }

    if (dirent.isDirectory()) {
      options.entries.push({
        path: relativePath,
        kind: 'directory',
        size_bytes: 0,
      });
      await scanDirectory({
        ...options,
        directory: absolutePath,
      });
      continue;
    }

    if (dirent.isSymbolicLink()) {
      options.entries.push({
        path: relativePath,
        kind: 'symlink',
        size_bytes: stats.size,
        mtime: stats.mtime.toISOString(),
      });
      continue;
    }

    if (!dirent.isFile()) {
      options.skipped.push({
        path: relativePath,
        reason: 'unsupported',
        detail: 'Only regular files, directories, and symlinks are indexed.',
      });
      continue;
    }

    if (stats.size > MAX_INDEXED_FILE_BYTES) {
      options.skipped.push({
        path: relativePath,
        reason: 'large_file',
        detail: `File exceeds ${MAX_INDEXED_FILE_BYTES} bytes.`,
      });
      continue;
    }

    let content;
    try {
      content = await readFile(absolutePath);
    } catch (error) {
      options.skipped.push({
        path: relativePath,
        reason: 'unreadable',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (isBinary(content)) {
      options.skipped.push({
        path: relativePath,
        reason: 'binary',
        detail: 'Binary content is not useful for text indexing.',
      });
      continue;
    }

    const contentSha256 = sha256Buffer(content);
    const language = inferLanguage(relativePath);
    const entry: TreeEntry = {
      path: relativePath,
      kind: 'file',
      size_bytes: stats.size,
      mtime: stats.mtime.toISOString(),
      content_sha256: contentSha256,
      ...(language ? { language } : {}),
    };
    options.entries.push(entry);
    options.files.push({
      path: relativePath,
      absolute_path: absolutePath,
      mtime: stats.mtime.toISOString(),
      size_bytes: stats.size,
      content_sha256: contentSha256,
      ...(language ? { language } : {}),
    });
  }
}

function classifyStaticSkip(
  relativePath: string,
  isDirectory: boolean,
): SkipEntry | null {
  const segments = relativePath.split('/');
  const name = segments.at(-1) ?? relativePath;
  const lowerName = name.toLowerCase();
  const lowerPath = relativePath.toLowerCase();

  if (segments.some((segment) => INTERNAL_DIRECTORIES.has(segment))) {
    return {
      path: relativePath,
      reason: 'unsupported',
      detail: 'Agentflow or git internal directory.',
    };
  }

  if (segments.some((segment) => DEPENDENCY_DIRECTORIES.has(segment))) {
    return {
      path: relativePath,
      reason: 'dependency',
      detail: 'Dependency directory.',
    };
  }

  if (isDirectory && GENERATED_DIRECTORIES.has(name)) {
    return {
      path: relativePath,
      reason: 'unsupported',
      detail: 'Generated output directory.',
    };
  }

  if (isSensitivePath(lowerPath, lowerName)) {
    return {
      path: relativePath,
      reason: 'sensitive_path',
      detail: 'Potential secret or credential path.',
    };
  }

  if (!isDirectory && lowerName.endsWith('.log')) {
    return {
      path: relativePath,
      reason: 'log_file',
      detail: 'Log files are not indexed.',
    };
  }

  return null;
}

async function isGitIgnored(
  repoRoot: string,
  relativePath: string,
  isDirectory: boolean,
): Promise<boolean> {
  const checkPath = isDirectory
    ? `${toPosixPath(relativePath)}/`
    : relativePath;

  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', checkPath], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

function isSensitivePath(lowerPath: string, lowerName: string): boolean {
  if (SENSITIVE_FILE_NAMES.has(lowerName) || lowerName.startsWith('.env.')) {
    return true;
  }

  return (
    lowerName.endsWith('.pem') ||
    lowerName.endsWith('.key') ||
    lowerPath.includes('/secret') ||
    lowerPath.includes('/secrets') ||
    lowerPath.includes('/credential') ||
    lowerPath.includes('/credentials')
  );
}

function isBinary(content: Buffer): boolean {
  const sampleLength = Math.min(content.length, BINARY_SAMPLE_BYTES);
  for (let index = 0; index < sampleLength; index += 1) {
    if (content[index] === 0) {
      return true;
    }
  }

  return false;
}

function inferLanguage(relativePath: string): string | undefined {
  const name = path.posix.basename(relativePath).toLowerCase();
  const ext = path.posix.extname(relativePath).toLowerCase();

  if (name === 'package.json' || ext === '.json') {
    return 'JSON';
  }

  const byExtension: Readonly<Record<string, string>> = {
    '.cjs': 'JavaScript',
    '.css': 'CSS',
    '.go': 'Go',
    '.html': 'HTML',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript JSX',
    '.md': 'Markdown',
    '.mdx': 'MDX',
    '.mjs': 'JavaScript',
    '.py': 'Python',
    '.rs': 'Rust',
    '.sh': 'Shell',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript JSX',
    '.yaml': 'YAML',
    '.yml': 'YAML',
  };

  return byExtension[ext];
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
