import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JsonSchemaValidator,
  SchemaValidationError,
  isRecord,
  type LoadedJsonSchema,
} from './validator.js';

export const LLM_PAYLOAD_TYPES = [
  'router_dispatch',
  'role_output',
  'planner_package',
  'change_package',
  'evaluator_report',
] as const;

export type LlmPayloadType = (typeof LLM_PAYLOAD_TYPES)[number];

export const PROJECT_INDEX_TYPES = [
  'manifest',
  'overview',
  'repo_tree',
  'commands',
  'module',
  'document_index',
  'document_summary',
  'build_report',
] as const;

export type ProjectIndexType = (typeof PROJECT_INDEX_TYPES)[number];

export const ARTIFACT_TYPES = [
  'run_state',
  'unit_state',
  'artifact_index',
  'routing_decision',
  'role_run_request',
  'role_input',
  'role_output',
  'planner_package',
  'batch_schedule',
  'acceptance_contract',
  'generation_input',
  'change_package',
  'evaluation_input',
  'evaluator_report',
  'unit_decision',
  'final_report',
  'stop_report',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const LLM_SCHEMA_IDS: Readonly<Record<LlmPayloadType, string>> = {
  router_dispatch: 'agentflow.schema.llm.router_dispatch.v1',
  role_output: 'agentflow.schema.llm.role_output.v1',
  planner_package: 'agentflow.schema.llm.planner_package.v1',
  change_package: 'agentflow.schema.llm.change_package.v1',
  evaluator_report: 'agentflow.schema.llm.evaluator_report.v1',
};

export const PROJECT_INDEX_SCHEMA_IDS: Readonly<
  Record<ProjectIndexType, string>
> = {
  manifest: 'agentflow.schema.project_index.manifest.v1',
  overview: 'agentflow.schema.project_index.overview.v1',
  repo_tree: 'agentflow.schema.project_index.repo_tree.v1',
  commands: 'agentflow.schema.project_index.commands.v1',
  module: 'agentflow.schema.project_index.module.v1',
  document_index: 'agentflow.schema.project_index.document_index.v1',
  document_summary: 'agentflow.schema.project_index.document_summary.v1',
  build_report: 'agentflow.schema.project_index.build_report.v1',
};

export const ARTIFACT_SCHEMA_IDS: Readonly<Record<ArtifactType, string>> = {
  run_state: 'agentflow.schema.artifact.run_state.v1',
  unit_state: 'agentflow.schema.artifact.unit_state.v1',
  artifact_index: 'agentflow.schema.artifact.artifact_index.v1',
  routing_decision: 'agentflow.schema.artifact.routing_decision.v1',
  role_run_request: 'agentflow.schema.artifact.role_run_request.v1',
  role_input: 'agentflow.schema.artifact.role_input.v1',
  role_output: 'agentflow.schema.artifact.role_output.v1',
  planner_package: 'agentflow.schema.artifact.planner_package.v1',
  batch_schedule: 'agentflow.schema.artifact.batch_schedule.v1',
  acceptance_contract: 'agentflow.schema.artifact.acceptance_contract.v1',
  generation_input: 'agentflow.schema.artifact.generation_input.v1',
  change_package: 'agentflow.schema.artifact.change_package.v1',
  evaluation_input: 'agentflow.schema.artifact.evaluation_input.v1',
  evaluator_report: 'agentflow.schema.artifact.evaluator_report.v1',
  unit_decision: 'agentflow.schema.artifact.unit_decision.v1',
  final_report: 'agentflow.schema.artifact.final_report.v1',
  stop_report: 'agentflow.schema.artifact.stop_report.v1',
};

const ARTIFACT_TYPES_SET = new Set<string>(ARTIFACT_TYPES);

export class SchemaRegistry {
  private readonly validator: JsonSchemaValidator;

  private constructor(validator: JsonSchemaValidator) {
    this.validator = validator;
  }

  static load(schemaRoot = defaultSchemaRoot()): SchemaRegistry {
    return new SchemaRegistry(
      new JsonSchemaValidator(loadJsonSchemas(schemaRoot)),
    );
  }

  assertLlmPayload(payloadType: LlmPayloadType, value: unknown): void {
    this.validator.assertValid(
      LLM_SCHEMA_IDS[payloadType],
      value,
      'payload_schema_invalid',
    );
  }

  assertProjectIndex(projectIndexType: ProjectIndexType, value: unknown): void {
    this.validator.assertValid(
      PROJECT_INDEX_SCHEMA_IDS[projectIndexType],
      value,
      'project_index_schema_invalid',
    );
  }

  assertCanonicalArtifact(artifactType: ArtifactType, value: unknown): void {
    this.validator.assertValid(
      ARTIFACT_SCHEMA_IDS[artifactType],
      value,
      'canonical_schema_invalid',
    );
  }

  assertBySchemaId(schemaId: string, value: unknown): void {
    this.validator.assertValid(
      schemaId,
      value,
      classificationForSchemaId(schemaId),
    );
  }

  schemaIdForCanonical(value: unknown): string {
    const artifactType = inferArtifactType(value);
    return ARTIFACT_SCHEMA_IDS[artifactType];
  }

  schemaIds(): readonly string[] {
    return this.validator.schemaIds();
  }
}

function defaultSchemaRoot(): string {
  const cwdSchemaRoot = path.resolve(process.cwd(), 'schemas');
  if (existsSync(cwdSchemaRoot)) {
    return cwdSchemaRoot;
  }

  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'schemas',
  );
}

function classificationForSchemaId(
  schemaId: string,
):
  | 'payload_schema_invalid'
  | 'project_index_schema_invalid'
  | 'canonical_schema_invalid' {
  if (schemaId.startsWith('agentflow.schema.llm.')) {
    return 'payload_schema_invalid';
  }

  if (schemaId.startsWith('agentflow.schema.project_index.')) {
    return 'project_index_schema_invalid';
  }

  return 'canonical_schema_invalid';
}

export function canonicalSchemaVersion(artifactType: ArtifactType): string {
  return `agentflow.${artifactType}.v1`;
}

export function inferArtifactType(value: unknown): ArtifactType {
  if (!isRecord(value)) {
    throw new SchemaValidationError({
      classification: 'canonical_schema_invalid',
      message: 'Canonical artifact must be a JSON object.',
    });
  }

  const artifactType = value.artifact_type;
  if (
    typeof artifactType === 'string' &&
    ARTIFACT_TYPES_SET.has(artifactType)
  ) {
    return artifactType as ArtifactType;
  }

  const schemaVersion = value.schema_version;
  if (typeof schemaVersion === 'string') {
    const match = /^agentflow\.([a-z_]+)\.v1$/.exec(schemaVersion);
    const typeFromVersion = match?.[1];
    if (typeFromVersion && ARTIFACT_TYPES_SET.has(typeFromVersion)) {
      return typeFromVersion as ArtifactType;
    }
  }

  throw new SchemaValidationError({
    classification: 'schema_not_found',
    message:
      'Could not infer artifact schema. Expected artifact_type or schema_version.',
  });
}

function loadJsonSchemas(schemaRoot: string): readonly LoadedJsonSchema[] {
  const schemaFiles = listSchemaFiles(schemaRoot);

  return schemaFiles.map((filePath) => {
    const schema = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const id = schema.$id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new SchemaValidationError({
        classification: 'schema_not_found',
        message: `Schema file is missing a string $id: ${filePath}`,
      });
    }

    return {
      id,
      filePath,
      schema,
    };
  });
}

function listSchemaFiles(root: string): readonly string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSchemaFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.schema.json')) {
      files.push(entryPath);
    }
  }

  return files.sort();
}
