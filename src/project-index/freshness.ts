import path from 'node:path';

import { SchemaRegistry } from '../schemas/registry.js';
import { SchemaValidationError, isRecord } from '../schemas/validator.js';
import {
  PROJECT_INDEX_BUILDER_VERSION,
  PROJECT_INDEX_SCHEMA_VERSIONS,
  type FileFingerprint,
  type ProjectIndexManifest,
  type RepositoryScan,
} from './types.js';
import { readJsonFile } from './util.js';

export async function readFreshManifest(options: {
  readonly outDir: string;
  readonly headSha: string;
  readonly configHash: string | null;
  readonly scan: RepositoryScan;
  readonly registry: SchemaRegistry;
}): Promise<ProjectIndexManifest | null> {
  try {
    const manifest = await readJsonFile<ProjectIndexManifest>(
      path.join(options.outDir, 'manifest.json'),
    );
    const buildReport = await readJsonFile<Record<string, unknown>>(
      path.join(options.outDir, 'build-report.json'),
    );

    options.registry.assertProjectIndex('manifest', manifest);
    options.registry.assertProjectIndex('build_report', buildReport);

    if (
      manifest.head.sha !== options.headSha ||
      manifest.config_hash !== options.configHash ||
      manifest.builder.version !== PROJECT_INDEX_BUILDER_VERSION ||
      manifest.schema_versions.manifest !==
        PROJECT_INDEX_SCHEMA_VERSIONS.manifest
    ) {
      return null;
    }

    const freshness = isRecord(buildReport.freshness)
      ? buildReport.freshness
      : null;
    if (
      !freshness ||
      !isRecord(freshness.head) ||
      freshness.head.sha !== options.headSha ||
      freshness.config_hash !== options.configHash ||
      freshness.builder_version !== PROJECT_INDEX_BUILDER_VERSION ||
      freshness.schema_version !== PROJECT_INDEX_SCHEMA_VERSIONS.manifest
    ) {
      return null;
    }

    const indexedFiles = Array.isArray(freshness.indexed_files)
      ? (freshness.indexed_files as readonly FileFingerprint[])
      : [];

    return sameFingerprints(indexedFiles, options.scan.files) ? manifest : null;
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      return null;
    }
    return null;
  }
}

function sameFingerprints(
  left: readonly FileFingerprint[],
  right: readonly FileFingerprint[],
): boolean {
  const normalize = (fingerprints: readonly FileFingerprint[]) =>
    fingerprints
      .map((fingerprint) => ({
        path: fingerprint.path,
        mtime: fingerprint.mtime,
        size_bytes: fingerprint.size_bytes,
        content_sha256: fingerprint.content_sha256,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
