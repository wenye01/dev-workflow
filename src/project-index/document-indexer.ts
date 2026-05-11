import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '../core/types.js';
import {
  PROJECT_INDEX_SCHEMA_VERSIONS,
  type DocumentIndex,
  type DocumentIndexEntry,
  type DocumentKind,
  type DocumentSection,
  type DocumentSummary,
  type ModuleIndex,
  type RepositoryScan,
  type ScannedFile,
} from './types.js';
import { joinArtifactRef, sanitizeRefId, titleizeIdentifier } from './util.js';

export async function buildDocumentIndex(options: {
  readonly repo: string;
  readonly generatedAt: string;
  readonly scan: RepositoryScan;
  readonly modules: readonly ModuleIndex[];
  readonly outRef: ArtifactRef;
}): Promise<{
  readonly index: DocumentIndex;
  readonly summaries: readonly DocumentSummary[];
}> {
  const documents: DocumentIndexEntry[] = [];
  const summaries: DocumentSummary[] = [];
  const documentFiles = options.scan.files.filter(isDocumentationFile);

  for (const file of documentFiles) {
    const content = await readFile(file.absolute_path, 'utf8');
    const sections = parseSections(content);
    const title = readTitle(content, file.path);
    const docId = uniqueDocId(
      file.path,
      new Set(documents.map((doc) => doc.doc_id)),
    );
    const kind = inferDocumentKind(file.path);
    const summaryRef = joinArtifactRef(
      options.outRef,
      'documents',
      'summaries',
      `${docId}.json`,
    );
    const relatedModules = inferRelatedModules(file, options.modules);
    const summary = summarizeDocument(content, title);

    summaries.push({
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.document_summary,
      doc_id: docId,
      path: file.path,
      title,
      kind,
      content_sha256: file.content_sha256,
      mtime: file.mtime,
      summary,
      sections,
      anchors: sections
        .map((section) => section.anchor)
        .filter((anchor): anchor is string => typeof anchor === 'string'),
      source: {
        path: file.path,
        content_sha256: file.content_sha256,
      },
    });

    documents.push({
      doc_id: docId,
      path: file.path,
      title,
      kind,
      content_sha256: file.content_sha256,
      mtime: file.mtime,
      sections,
      summary_ref: summaryRef,
      related_modules: relatedModules,
    });
  }

  return {
    index: {
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.document_index,
      repo: options.repo,
      generated_at: options.generatedAt,
      documents,
    },
    summaries,
  };
}

function isDocumentationFile(file: ScannedFile): boolean {
  const lowerPath = file.path.toLowerCase();
  const name = path.posix.basename(lowerPath);
  const ext = path.posix.extname(lowerPath);

  if (['.md', '.mdx', '.rst'].includes(ext)) {
    return (
      name === 'readme.md' ||
      name === 'readme.mdx' ||
      lowerPath.startsWith('docs/') ||
      lowerPath.includes('/docs/') ||
      lowerPath.includes('design') ||
      lowerPath.includes('api') ||
      lowerPath.includes('config') ||
      lowerPath.includes('runbook') ||
      lowerPath.includes('changelog') ||
      lowerPath.includes('contributing')
    );
  }

  return false;
}

function parseSections(content: string): readonly DocumentSection[] {
  const lines = content.split(/\r?\n/);
  const headings: Array<{ title: string; anchor: string; line: number }> = [];

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      return;
    }

    const title = match[2]?.trim() ?? 'Section';
    headings.push({
      title,
      anchor: anchorFor(title),
      line: index + 1,
    });
  });

  if (headings.length === 0) {
    return [
      {
        title: 'Document',
        anchor: 'document',
        line_start: 1,
        line_end: Math.max(lines.length, 1),
      },
    ];
  }

  return headings.map((heading, index) => ({
    title: heading.title,
    anchor: heading.anchor,
    line_start: heading.line,
    line_end: (headings[index + 1]?.line ?? lines.length + 1) - 1,
  }));
}

function readTitle(content: string, relativePath: string): string {
  const firstHeading = /^(?:#|=+)\s*(.+?)\s*$/m.exec(content);
  if (firstHeading?.[1]) {
    return firstHeading[1].trim();
  }

  return titleizeIdentifier(path.posix.basename(relativePath));
}

function uniqueDocId(relativePath: string, existing: Set<string>): string {
  const base = sanitizeRefId(relativePath.replace(/\.[^.]+$/, ''), 'document');
  let candidate = base;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function inferDocumentKind(relativePath: string): DocumentKind {
  const lowerPath = relativePath.toLowerCase();
  const name = path.posix.basename(lowerPath);

  if (name.startsWith('readme')) {
    return 'readme';
  }
  if (lowerPath.includes('changelog')) {
    return 'changelog';
  }
  if (lowerPath.includes('runbook')) {
    return 'runbook';
  }
  if (lowerPath.includes('api')) {
    return 'api';
  }
  if (lowerPath.includes('config')) {
    return 'config';
  }
  if (lowerPath.includes('design') || lowerPath.startsWith('docs/')) {
    return 'design';
  }

  return 'other';
}

function inferRelatedModules(
  file: ScannedFile,
  modules: readonly ModuleIndex[],
): readonly string[] {
  if (file.path.toLowerCase().startsWith('readme')) {
    return modules.map((module) => module.module_id);
  }

  const lowerPath = file.path.toLowerCase();
  return modules
    .filter(
      (module) =>
        lowerPath.includes(module.module_id.toLowerCase()) ||
        lowerPath.includes(module.name.toLowerCase()),
    )
    .map((module) => module.module_id);
}

function summarizeDocument(content: string, title: string): string {
  const paragraph = content
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((block) => block.length > 0 && !block.startsWith('```'));

  if (!paragraph) {
    return `${title} documents project information.`;
  }

  return paragraph.length > 240 ? `${paragraph.slice(0, 237)}...` : paragraph;
}

function anchorFor(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}
