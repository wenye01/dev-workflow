import { isRecord } from '../schemas/validator.js';

export interface CanonicalArtifactForMarkdown {
  readonly schema_version: string;
  readonly artifact_type: string;
  readonly artifact_id: string;
  readonly run_id?: string;
  readonly batch_id?: string;
  readonly unit_id?: string;
  readonly created_at?: string;
  readonly payload?: unknown;
}

export function renderMarkdownView(
  artifact: CanonicalArtifactForMarkdown,
): string {
  const lines = [
    `# ${titleize(artifact.artifact_type)}`,
    '',
    '<!-- Generated from canonical JSON. This Markdown view is not authoritative state. -->',
    '',
    `- Schema: ${artifact.schema_version}`,
    `- Artifact ID: ${artifact.artifact_id}`,
  ];

  if (artifact.run_id) {
    lines.push(`- Run: ${artifact.run_id}`);
  }
  if (artifact.batch_id) {
    lines.push(`- Batch: ${artifact.batch_id}`);
  }
  if (artifact.unit_id) {
    lines.push(`- Unit: ${artifact.unit_id}`);
  }
  if (artifact.created_at) {
    lines.push(`- Created: ${artifact.created_at}`);
  }

  lines.push('', ...renderPayloadSummary(artifact.payload), '');
  return `${lines.join('\n')}\n`;
}

function renderPayloadSummary(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [
      '## Payload',
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ];
  }

  const lines: string[] = [];
  const summary = payload.summary;
  const goal = payload.goal;
  const objective = payload.objective;

  if (typeof goal === 'string') {
    lines.push('## Goal', '', goal, '');
  } else if (typeof objective === 'string') {
    lines.push('## Objective', '', objective, '');
  }

  if (typeof summary === 'string') {
    lines.push('## Summary', '', summary, '');
  }

  const sections: ReadonlyArray<readonly [string, unknown]> = [
    ['Changed Files', payload.changed_files],
    ['Criteria Results', payload.criteria_results],
    ['Failures', payload.failures],
    ['Risks', payload.residual_risks ?? payload.risks],
    ['Units', payload.units],
    ['Contracts', payload.contracts],
  ];

  for (const [heading, value] of sections) {
    if (Array.isArray(value) && value.length > 0) {
      lines.push(`## ${heading}`, '', ...renderArray(value), '');
    }
  }

  lines.push(
    '## Canonical Payload',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  );
  return lines;
}

function renderArray(values: readonly unknown[]): string[] {
  return values.map((value) => {
    if (isRecord(value)) {
      const label =
        firstString(value.title, value.ref, value.path, value.criterion) ??
        JSON.stringify(value);
      return `- ${label}`;
    }

    return `- ${String(value)}`;
  });
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function titleize(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
