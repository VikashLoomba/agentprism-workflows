import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { resolveModelScopeWithDiagnostics, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { adapterError } from "./errors.js";

export type ThinkingLevel = ModelThinkingLevel;

/** Additive ACP metadata understood by AgentPrism's generic config validator. */
export const CONFIG_OPTION_META_NAMESPACE = "@automatalabs/agentprism";

export const MODEL_DISCOVERY_META_KEY = "@automatalabs/agentprism.modelDiscovery";

export interface ModelDiscoveryPreferences {
  source: "enabledModels";
  preferred: string[];
  unmatched: string[];
}

export async function modelDiscoveryPreferences(
  enabledModels: string[] | undefined,
  availableModels: readonly Model<Api>[],
): Promise<ModelDiscoveryPreferences | undefined> {
  if (!enabledModels?.length) return undefined;
  // Pi's public resolver only reads getAvailable(). Bind it to the completed
  // catalog being advertised so another provider refresh cannot make the
  // shortlist disagree with the picker. Keep all pattern semantics in Pi.
  const catalog = { getAvailable: async () => availableModels } as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(enabledModels, catalog);
  return {
    source: "enabledModels",
    preferred: scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
    unmatched: diagnostics.filter(({ code }) => code === "no-match").map(({ pattern }) => pattern),
  };
}

const SYNTHETIC_ALL_THINKING_MODEL = {
  reasoning: {},
  thinkingLevelMap: new Proxy({}, {
    get: (_target, property) => typeof property === "string" ? property : undefined,
  }),
} as unknown as Model<Api>;

/**
 * Pi's complete, ordered domain, derived once from pi's own model-aware helper.
 * This is intentionally not a hardcoded mirror of pi's module-private ladder.
 */
export const RECOGNIZED_THINKING_LEVELS: readonly ModelThinkingLevel[] = Object.freeze(
  getSupportedThinkingLevels(SYNTHETIC_ALL_THINKING_MODEL),
);

function supportedThinkingLevels(model: Model<Api> | undefined): readonly ModelThinkingLevel[] {
  // With no selected model, the pi-derived domain is the only safe best-effort catalog.
  return model ? getSupportedThinkingLevels(model) : RECOGNIZED_THINKING_LEVELS;
}

export function thinkingLevelOption(session: AgentSession): SessionConfigOption {
  const supported = supportedThinkingLevels(session.model);
  return {
    id: "thinkingLevel",
    name: "Thinking level",
    type: "select",
    category: "thought_level",
    currentValue: session.thinkingLevel,
    options: supported.map((value) => ({ value, name: value })),
    _meta: {
      [CONFIG_OPTION_META_NAMESPACE]: {
        recognizedValues: RECOGNIZED_THINKING_LEVELS,
      },
    },
  };
}

export function modelOption(
  session: AgentSession,
  availableModels: readonly Model<Api>[],
  preferences?: ModelDiscoveryPreferences,
): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: session.model ? `${session.model.provider}/${session.model.id}` : "",
    options: availableModels.map((model) => ({ value: `${model.provider}/${model.id}`, name: model.name })),
    ...(preferences ? { _meta: { [MODEL_DISCOVERY_META_KEY]: preferences } } : {}),
  };
}

export async function applyConfig(
  session: AgentSession,
  modelRuntime: ModelRuntime,
  _availableModels: readonly Model<Api>[],
  configId: string,
  value: string | boolean,
  enabledModels?: string[],
): Promise<{
  configOptions: SessionConfigOption[];
  availableModels: readonly Model<Api>[];
  preferences: ModelDiscoveryPreferences | undefined;
}> {
  if (configId !== "thinkingLevel" && configId !== "model") {
    throw adapterError("unknown_config_option");
  }
  if (typeof value !== "string") throw adapterError("invalid_config_type");
  if (configId === "thinkingLevel") {
    if (!(RECOGNIZED_THINKING_LEVELS as readonly string[]).includes(value)) {
      throw adapterError("invalid_config_value");
    }
    const requested = value as ModelThinkingLevel;
    const supported = supportedThinkingLevels(session.model);
    const effective = session.model && !supported.includes(requested)
      ? clampThinkingLevel(session.model, requested)
      : requested;
    const availableModels = [...await modelRuntime.getAvailable()];
    const preferences = await modelDiscoveryPreferences(enabledModels, availableModels);
    session.setThinkingLevel(effective);
    return {
      configOptions: [thinkingLevelOption(session), modelOption(session, availableModels, preferences)],
      availableModels,
      preferences,
    };
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw adapterError("invalid_model");
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  const availableModels = [...await modelRuntime.getAvailable()];
  const model = availableModels.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw adapterError("invalid_model");
  const preferences = await modelDiscoveryPreferences(enabledModels, availableModels);
  try {
    await session.setModel(model);
  } catch (error) {
    if (error instanceof Error && /^no api key for /i.test(error.message)) {
      throw adapterError("auth_error");
    }
    throw error;
  }
  return {
    configOptions: [thinkingLevelOption(session), modelOption(session, availableModels, preferences)],
    availableModels,
    preferences,
  };
}
