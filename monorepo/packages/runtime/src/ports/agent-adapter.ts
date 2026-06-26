import type {
  Activation,
  AgentDefinition,
  Capability,
  ContextPackage,
  ExpectedOutput,
  ProducedArtifact,
  RuntimeError,
  Usage
} from "../contracts/index.js";

export interface AgentRunInput {
  activation: Activation;
  agent: AgentDefinition;
  context: ContextPackage;
  expected_outputs: ExpectedOutput[];
  runtime_hints?: Capability["runtime_hints"];
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "timeout" | "cancelled";
  outputs?: ProducedArtifact[];
  usage?: Usage;
  message?: string;
  error?: RuntimeError;
  metadata?: Record<string, unknown>;
}

export interface AgentAdapter {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
