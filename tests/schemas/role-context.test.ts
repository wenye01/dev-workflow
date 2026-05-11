import { describe, expect, it } from 'vitest';

import {
  SchemaRegistry,
  canonicalSchemaVersion,
  type ArtifactType,
} from '../../src/schemas/registry.js';
import { SchemaValidationError } from '../../src/schemas/validator.js';

describe('role context schemas', () => {
  it('accepts materialized context carried as Project Index refs', () => {
    const registry = SchemaRegistry.load();

    for (const artifact of [
      canonicalArtifact('role_input', roleInputPayload(selectedContext())),
      canonicalArtifact(
        'role_run_request',
        roleRunRequestPayload(selectedContext()),
      ),
      canonicalArtifact(
        'generation_input',
        generationInputPayload(selectedContext()),
        { unit_id: 'unit-auth-001' },
      ),
    ]) {
      expect(() =>
        registry.assertCanonicalArtifact(
          artifact.artifact_type as ArtifactType,
          artifact,
        ),
      ).not.toThrow();
    }
  });

  it('rejects direct project overview fields in role input context', () => {
    const registry = SchemaRegistry.load();
    const artifact = canonicalArtifact(
      'role_input',
      roleInputPayload({
        ...selectedContext(),
        project_overview: 'Inline project overview is not allowed.',
      }),
    );

    expect(() =>
      registry.assertCanonicalArtifact('role_input', artifact),
    ).toThrowError(SchemaValidationError);
  });
});

function roleInputPayload(context: unknown): Record<string, unknown> {
  return {
    role: 'generator.implementer',
    task: {
      goal: 'Implement refresh-token handling.',
    },
    acceptance_contract: {
      objective: 'Refresh token is issued with the access token.',
    },
    context,
    constraints: {
      write_permission: 'worktree_write',
      allowed_paths: ['src/auth/**', 'tests/auth/**'],
      forbidden_paths: ['.env', 'deploy/**'],
      forbidden_actions: ['push', 'merge', 'deploy'],
    },
    required_output_schema: 'agentflow.schema.llm.role_output.v1',
  };
}

function roleRunRequestPayload(context: unknown): Record<string, unknown> {
  return {
    request_id: 'request-generator-001',
    role: 'generator.implementer',
    task: {
      goal: 'Implement refresh-token handling.',
    },
    context,
    write_permission: 'worktree_write',
    input_artifacts: ['.agentflow/planner/package.json'],
    output_artifact: '.agentflow/units/unit-auth-001/roles/generator.json',
    required_output_schema: 'agentflow.schema.llm.role_output.v1',
  };
}

function generationInputPayload(context: unknown): Record<string, unknown> {
  return {
    mode: 'initial',
    unit: {
      ref: 'auth-refresh',
      goal: 'Implement refresh-token handling.',
    },
    acceptance_contract: {
      objective: 'Refresh token is issued with the access token.',
    },
    context,
    constraints: {
      write_permission: 'worktree_write',
      allowed_paths: ['src/auth/**', 'tests/auth/**'],
      forbidden_paths: ['.env', 'deploy/**'],
      forbidden_actions: ['push', 'merge', 'deploy'],
    },
  };
}

function selectedContext(): Record<string, unknown> {
  return {
    project_index_refs: {
      manifest: projectIndexRef(
        'manifest',
        '.agentflow/project-index/manifest.json',
        'agentflow.schema.project_index.manifest.v1',
        '9999999999999999999999999999999999999999999999999999999999999999',
      ),
      overview: projectIndexRef(
        'overview',
        '.agentflow/project-index/overview.json',
        'agentflow.schema.project_index.overview.v1',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
      commands: [
        projectIndexRef(
          'commands',
          '.agentflow/project-index/commands.json',
          'agentflow.schema.project_index.commands.v1',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ),
      ],
      modules: [
        projectIndexRef(
          'module',
          '.agentflow/project-index/modules/auth.json',
          'agentflow.schema.project_index.module.v1',
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ),
      ],
      documents: [
        projectIndexRef(
          'document_index',
          '.agentflow/project-index/documents/index.json',
          'agentflow.schema.project_index.document_index.v1',
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ),
      ],
      document_summaries: [
        projectIndexRef(
          'document_summary',
          '.agentflow/project-index/documents/summaries/readme.json',
          'agentflow.schema.project_index.document_summary.v1',
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        ),
      ],
    },
    source_slices: ['.agentflow/index/source-slices/auth.json'],
    run_artifacts: ['.agentflow/planner/package.json'],
    feedback: [],
    worktree_status: '.agentflow/inputs/worktree-status.json',
  };
}

function projectIndexRef(
  kind: string,
  ref: string,
  schemaId: string,
  contentSha256: string,
): Record<string, unknown> {
  return {
    kind,
    ref,
    schema_id: schemaId,
    content_sha256: contentSha256,
  };
}

function canonicalArtifact(
  artifactType: ArtifactType,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: canonicalSchemaVersion(artifactType),
    artifact_type: artifactType,
    artifact_id: `${artifactType}-fixture`,
    run_id: 'run-fixture',
    producer: {
      kind: 'orchestrator',
    },
    input_artifacts: [],
    created_at: '2026-05-11T00:00:00.000Z',
    payload,
    commit_refs: [],
    ...extra,
  };
}
