import { isContextRequest } from "./context.js";
import { isExpectedOutput, type ExpectedOutput } from "./artifact.js";
import type { ContextRequest } from "./context.js";
import type { AgentRef } from "./ids.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isRecord,
  isStringArray,
  schemaError,
  type SchemaDecodeOutcome
} from "./schema.js";

export interface WorkflowSpec {
  units: WorkflowSpecUnit[];
}

export interface WorkflowSpecUnit {
  id: string;
  agent: AgentRef;
  objective: string;
  context: ContextRequest;
  output: ExpectedOutput;
  depends_on?: string[];
}

export function decodeWorkflowSpec(value: unknown): SchemaDecodeOutcome<WorkflowSpec> {
  return isWorkflowSpec(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: schemaError("workflow_spec payload did not match the runtime contract.")
      };
}

export function isWorkflowSpec(value: unknown): value is WorkflowSpec {
  if (!isRecord(value) || !hasOnlyKeys(value, ["units"]) || !Array.isArray(value.units)) {
    return false;
  }

  const units: WorkflowSpecUnit[] = [];
  const unitIds = new Set<string>();
  for (const unit of value.units) {
    if (!isWorkflowSpecUnit(unit) || unitIds.has(unit.id)) {
      return false;
    }

    units.push(unit);
    unitIds.add(unit.id);
  }

  return units.every((unit) => unit.depends_on === undefined || unit.depends_on.every((id) => unitIds.has(id)));
}

function isWorkflowSpecUnit(value: unknown): value is WorkflowSpecUnit {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "agent", "objective", "context", "output", "depends_on"])) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agent) &&
    isNonEmptyString(value.objective) &&
    isContextRequest(value.context) &&
    isExpectedOutput(value.output) &&
    (value.depends_on === undefined || isStringArray(value.depends_on))
  );
}
