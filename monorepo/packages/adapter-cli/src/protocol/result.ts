import type { AdapterCliArtifactDraft, AdapterCliUsage } from "./artifact.js";
import type { AdapterCliError } from "./errors.js";
import type { AdapterCliProgressEvent } from "./progress.js";
import type { AdapterCliSchemaVersion } from "./request.js";

export type AdapterCliStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface AdapterCliResult {
  schema_version: AdapterCliSchemaVersion;
  invocation_id: string;
  status: AdapterCliStatus;
  exit_code: number;
  message?: string;
  session_id?: string;
  outputs?: AdapterCliArtifactDraft[];
  usage?: AdapterCliUsage;
  progress_events?: AdapterCliProgressEvent[];
  log_path?: string;
  error?: AdapterCliError;
}
