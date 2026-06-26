export interface AdapterCliProgressEvent {
  invocation_id: string;
  backend?: string;
  phase?: string;
  message?: string;
  command?: string;
  backend_event_type?: string;
  total_events?: number;
  timestamp?: string;
}
