export interface AdapterCliArtifactDraft {
  kind: string;
  schema_id?: string;
  ref?: string;
  payload?: unknown;
  blob?: {
    path?: string;
    uri?: string;
    content_type?: string;
    content_hash?: string;
    size_bytes?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface AdapterCliExpectedOutputSpec {
  ref?: string;
  kind?: string;
  schema_id?: string;
  required?: boolean;
}

export interface AdapterCliUsage {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  cost_usd?: number;
}
