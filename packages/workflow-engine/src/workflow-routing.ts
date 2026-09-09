import { loadAgentRegistry, type AgentDefinition } from "./agent-registry.js";
import { loadModelTierConfig, type ModelTierConfig } from "./model-tier-config.js";
import { deepFreeze } from "./strict-json.js";

/** Provider-affecting file inputs, captured once and reused by same-run continuation. */
export interface WorkflowRoutingSnapshot {
  modelTiers: ModelTierConfig | null;
  agentDefinitions: AgentDefinition[];
  mainModel?: string;
}

export function captureWorkflowRouting(cwd: string, agentsDir?: string, mainModel?: string): WorkflowRoutingSnapshot {
  const definitions = loadAgentRegistry(cwd, agentsDir ? { projectDir: agentsDir, userDir: agentsDir } : undefined);
  // Loaded definitions carry optional undefined fields. Persist their JSON representation.
  return deepFreeze(JSON.parse(JSON.stringify({
    modelTiers: loadModelTierConfig(),
    agentDefinitions: [...definitions.values()],
    ...(mainModel === undefined ? {} : { mainModel }),
  })) as WorkflowRoutingSnapshot);
}

export function isWorkflowRoutingSnapshot(value: unknown): value is WorkflowRoutingSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as WorkflowRoutingSnapshot;
  if (Object.keys(snapshot).some((key) => !["modelTiers", "agentDefinitions", "mainModel"].includes(key))) return false;
  if (snapshot.mainModel !== undefined && (typeof snapshot.mainModel !== "string" || !snapshot.mainModel.trim())) return false;
  const tiers = snapshot.modelTiers;
  if (tiers !== null && (!tiers || typeof tiers !== "object" || !tiers.tiers || typeof tiers.tiers !== "object" ||
    Array.isArray(tiers.tiers) || Object.values(tiers.tiers).some((model) => typeof model !== "string"))) return false;
  if (!Array.isArray(snapshot.agentDefinitions)) return false;
  const names = new Set<string>();
  return snapshot.agentDefinitions.every((definition) => {
    if (!definition || typeof definition !== "object" || Array.isArray(definition) ||
      typeof definition.name !== "string" || !definition.name || names.has(definition.name) ||
      typeof definition.prompt !== "string" || !["project", "user"].includes(definition.source) ||
      (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) ||
      (definition.description !== undefined && typeof definition.description !== "string") ||
      (definition.isolation !== undefined && definition.isolation !== "worktree") ||
      [definition.tools, definition.disallowedTools].some((list) => list !== undefined &&
        (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")))) return false;
    names.add(definition.name);
    return true;
  });
}
