import type { AgentDefinition } from "../contracts/index.js";
import type { AgentRegistry } from "../ports/index.js";

export class StaticAgentRegistry implements AgentRegistry {
  private readonly definitionsByKey = new Map<string, AgentDefinition>();
  private readonly definitionsByRef = new Map<string, AgentDefinition>();
  private readonly ambiguousRefs = new Set<string>();

  constructor(definitions: Iterable<AgentDefinition> = []) {
    for (const definition of definitions) {
      this.add(definition);
    }
  }

  async resolve(ref: string, version?: string): Promise<AgentDefinition | undefined> {
    if (version !== undefined) {
      return this.definitionsByKey.get(registryKey(ref, version));
    }

    if (this.ambiguousRefs.has(ref)) {
      return undefined;
    }

    return this.definitionsByRef.get(ref);
  }

  private add(definition: AgentDefinition): void {
    const key = registryKey(definition.ref, definition.version);
    if (this.definitionsByKey.has(key)) {
      throw new Error(`Duplicate agent definition for ${definition.ref}@${definition.version}.`);
    }

    this.definitionsByKey.set(key, definition);

    if (this.definitionsByRef.has(definition.ref)) {
      this.definitionsByRef.delete(definition.ref);
      this.ambiguousRefs.add(definition.ref);
      return;
    }

    if (!this.ambiguousRefs.has(definition.ref)) {
      this.definitionsByRef.set(definition.ref, definition);
    }
  }
}

function registryKey(ref: string, version: string): string {
  return `${ref}@${version}`;
}
