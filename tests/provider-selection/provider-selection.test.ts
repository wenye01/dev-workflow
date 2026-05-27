import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AdapterManager,
  AdapterSelectionError,
} from '../../src/adapters/adapter-manager.js';
import { parseArtifactRef } from '../../src/artifacts/paths.js';
import { normalizeConfig } from '../../src/config/config-loader.js';

describe('AdapterManager provider selection', () => {
  it('falls back when the preferred provider is unavailable', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-adapter-'));
    const config = normalizeConfig({
      providers: {
        primary: {
          agent: 'mock',
          model: 'first',
          available: false,
        },
        secondary: {
          agent: 'mock',
          model: 'second',
          scenario: 'success_no_change',
        },
      },
      roles: {
        'generator.implementer': {
          provider_candidates: [
            { provider: 'primary', model: 'first' },
            { provider: 'secondary', model: 'second' },
          ],
        },
      },
    });
    const outputArtifact = parseArtifactRef('.agentflow/roles/out.json');

    const result = await new AdapterManager(config, {
      checkCommandAvailability: false,
    }).runRole({
      requestId: 'request-1',
      role: 'generator.implementer',
      cwd,
      prompt: 'write the artifact',
      outputArtifact,
    });

    expect(result.status).toBe('completed');
    expect(result.provider).toBe('secondary');
    expect(result.model).toBe('second');
    expect(result.fallbackReason).toContain(
      'primary:provider_command_unavailable',
    );
    await expect(
      readFile(path.join(cwd, outputArtifact), 'utf8'),
    ).resolves.toContain('scenario success_no_change');
  });

  it('does not fall back on schema failure', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-schema-'));
    const config = normalizeConfig({
      providers: {
        schema: {
          agent: 'mock',
          model: 'schema-model',
          scenario: 'schema_failure',
        },
        secondary: {
          agent: 'mock',
          model: 'second',
          scenario: 'success_with_change',
        },
      },
      roles: {
        'planner.router': {
          provider_candidates: [
            { provider: 'schema', model: 'schema-model' },
            { provider: 'secondary', model: 'second' },
          ],
        },
      },
    });

    const result = await new AdapterManager(config, {
      checkCommandAvailability: false,
    }).runRole({
      requestId: 'request-2',
      role: 'planner.router',
      cwd,
      prompt: 'produce invalid schema',
    });

    expect(result.status).toBe('failed');
    expect(result.provider).toBe('schema');
    expect(result.error?.code).toBe('AGENTFLOW_SCHEMA_FAILURE');
    expect(result.candidates.map((candidate) => candidate.provider)).toEqual([
      'schema',
      'secondary',
    ]);
  });

  it('keeps provider hints inside the configured role candidate set', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-hint-'));
    const config = normalizeConfig({
      providers: {
        allowed: {
          agent: 'mock',
          model: 'allowed-model',
        },
        disallowed: {
          agent: 'mock',
          model: 'disallowed-model',
        },
      },
      roles: {
        'evaluator.contract_checker': {
          provider_candidates: [
            { provider: 'allowed', model: 'allowed-model' },
          ],
        },
      },
    });

    const result = await new AdapterManager(config, {
      checkCommandAvailability: false,
    }).runRole({
      requestId: 'request-3',
      role: 'evaluator.contract_checker',
      cwd,
      prompt: 'evaluate',
      providerHint: 'disallowed',
      modelHint: 'disallowed-model',
    });

    expect(result.provider).toBe('allowed');
    expect(result.model).toBe('allowed-model');
    expect(result.fallbackReason).toContain(
      'provider_hint_rejected_not_candidate:disallowed',
    );
    expect(result.fallbackReason).toContain(
      'model_hint_ignored:disallowed-model',
    );
  });

  it('returns a stable stop-report payload when no provider is usable', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-none-'));
    const config = normalizeConfig({
      providers: {
        disabled: {
          agent: 'mock',
          enabled: false,
        },
      },
      roles: {
        'planner.router': {
          provider_candidates: [{ provider: 'disabled' }],
        },
      },
    });

    await expect(
      new AdapterManager(config, {
        checkCommandAvailability: false,
      }).runRole({
        requestId: 'request-4',
        role: 'planner.router',
        cwd,
        prompt: 'plan',
      }),
    ).rejects.toBeInstanceOf(AdapterSelectionError);

    try {
      await new AdapterManager(config, {
        checkCommandAvailability: false,
      }).runRole({
        requestId: 'request-5',
        role: 'planner.router',
        cwd,
        prompt: 'plan',
      });
    } catch (error) {
      expect(
        (error as AdapterSelectionError).toStopReportPayload(),
      ).toMatchObject({
        status: 'stopped',
        reason_code: 'provider_selection_failed',
        classification: 'provider_unavailable',
        role: 'planner.router',
      });
    }
  });
});
