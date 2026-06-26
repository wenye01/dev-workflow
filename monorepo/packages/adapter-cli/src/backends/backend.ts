import type { AdapterCliRequest } from "../protocol/index.js";
import type { ProcessRunResult } from "../executor/index.js";
import type { AdapterCliResult } from "../protocol/index.js";

export interface BackendInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface AdapterCliBackend {
  readonly name: string;
  readonly aliases?: readonly string[];
  createInvocation(request: AdapterCliRequest): BackendInvocation;
  normalizeResult(request: AdapterCliRequest, result: ProcessRunResult): AdapterCliResult;
}
