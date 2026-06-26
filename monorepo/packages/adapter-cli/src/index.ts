export * from "./backends/index.js";
export * from "./errors/index.js";
export * from "./executor/index.js";
export * from "./parser/index.js";
export * from "./progress/index.js";
export type * from "./protocol/index.js";

export const adapterCliPackage = {
  name: "@agentflow/adapter-cli",
  schema_version: "adapter-cli/v1",
  phase: 0
} as const;
