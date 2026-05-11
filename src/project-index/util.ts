import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '../core/types.js';
import { parseArtifactRef } from '../artifacts/paths.js';

export function sha256Buffer(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
  return sha256Buffer(await readFile(filePath));
}

export async function hashOptionalFile(
  filePath?: string,
): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  return hashFile(filePath);
}

export function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, jsonBytes(value), 'utf8');
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function fileMetadata(filePath: string): Promise<{
  readonly content_sha256: string;
  readonly size_bytes: number;
}> {
  const [contentHash, stats] = await Promise.all([
    hashFile(filePath),
    stat(filePath),
  ]);

  return {
    content_sha256: contentHash,
    size_bytes: stats.size,
  };
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function relativePosix(from: string, to: string): string {
  return toPosixPath(path.relative(from, to));
}

export function resolveProjectIndexOut(
  repoRoot: string,
  outDir: string,
): {
  readonly outDir: string;
  readonly outRelative: string;
  readonly outRef: ArtifactRef;
} {
  const resolved = path.isAbsolute(outDir)
    ? path.resolve(outDir)
    : path.resolve(repoRoot, outDir);
  const relative = relativePosix(repoRoot, resolved);

  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new ProjectIndexError({
      code: 'AGENTFLOW_PROJECT_INDEX_OUTSIDE_REPO',
      message: `Project Index output must be inside the repository: ${resolved}`,
    });
  }

  if (relative !== '.agentflow' && !relative.startsWith('.agentflow/')) {
    throw new ProjectIndexError({
      code: 'AGENTFLOW_PROJECT_INDEX_OUTSIDE_ARTIFACT_ROOT',
      message:
        'Project Index output must be under .agentflow so manifest refs remain valid artifacts.',
    });
  }

  return {
    outDir: resolved,
    outRelative: relative,
    outRef: parseArtifactRef(relative),
  };
}

export function joinArtifactRef(
  root: ArtifactRef,
  ...segments: readonly string[]
): ArtifactRef {
  return parseArtifactRef(path.posix.join(root, ...segments));
}

export function sanitizeRefId(value: string, fallback = 'item'): string {
  const sanitized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');

  return sanitized.length > 0 ? sanitized : fallback;
}

export function titleizeIdentifier(value: string): string {
  return value
    .split(/[-_/.:]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

export class ProjectIndexError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(options.message);
    this.name = 'ProjectIndexError';
    this.code = options.code;
    this.cause = options.cause;
  }
}
