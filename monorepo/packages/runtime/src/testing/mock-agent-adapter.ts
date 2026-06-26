import type { ExpectedOutput, ProducedArtifact, Usage } from "../contracts/index.js";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../ports/index.js";

export type MockAgentAdapterHandler = (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>;
export type MockAgentAdapterOutputFactory = (input: AgentRunInput) => ProducedArtifact[] | Promise<ProducedArtifact[]>;

export interface MockAgentAdapterOptions {
  handler?: MockAgentAdapterHandler;
  outputs?: ProducedArtifact[] | MockAgentAdapterOutputFactory;
  usage?: Usage;
  metadata?: Record<string, unknown>;
}

export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly options: MockAgentAdapterOptions = {}) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.options.handler !== undefined) {
      return this.options.handler(input);
    }

    return {
      status: "completed",
      outputs: await this.resolveOutputs(input),
      usage: this.options.usage ?? { calls: 1 },
      ...(this.options.metadata === undefined ? {} : { metadata: this.options.metadata })
    };
  }

  private async resolveOutputs(input: AgentRunInput): Promise<ProducedArtifact[]> {
    if (typeof this.options.outputs === "function") {
      return this.options.outputs(input);
    }

    if (this.options.outputs !== undefined) {
      return this.options.outputs;
    }

    const expectedOutputs = input.expected_outputs.length > 0 ? input.expected_outputs : [defaultExpectedOutput(input)];
    return expectedOutputs.map((expected) => ({
      ref: expected.ref,
      kind: expected.kind,
      schema_id: expected.schema_id,
      payload: {
        text: `Mock output for ${input.activation.objective.title}.`,
        agent_ref: input.agent.ref,
        activation_id: input.activation.id
      },
      metadata: {
        mock: true
      }
    }));
  }
}

export function createMockAgentAdapter(handler: MockAgentAdapterHandler): AgentAdapter;
export function createMockAgentAdapter(options?: MockAgentAdapterOptions): AgentAdapter;
export function createMockAgentAdapter(optionsOrHandler: MockAgentAdapterHandler | MockAgentAdapterOptions = {}): AgentAdapter {
  if (typeof optionsOrHandler === "function") {
    return new MockAgentAdapter({ handler: optionsOrHandler });
  }

  return new MockAgentAdapter(optionsOrHandler);
}

function defaultExpectedOutput(input: AgentRunInput): ExpectedOutput {
  return {
    ref: `${input.activation.id}/output`,
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    required: true
  };
}
