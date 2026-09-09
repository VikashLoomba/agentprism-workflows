import { redactText } from "@automatalabs/workflow-engine";
import { selectChoicePairs } from "./validate.js";
import type { HarnessConfigReport } from "./config.js";

const MAX_ENTRIES = 24;
const MAX_VALUE_LENGTH = 240;
// Deliberate classification by exact provider id, never a substring/name heuristic.
const OPENCODE_AGGREGATORS = new Set([
  "openrouter", "opencode", "opencode-go", "huggingface", "amazon-bedrock", "github-copilot",
]);
const MODEL_DISCOVERY_META = "@automatalabs/agentprism.modelDiscovery";

export interface HarnessConfigSummaryModel {
  modelId: string;
  /** Exact executable route; browse selectors never appear here. */
  route: string;
}

export interface HarnessConfigSummaryGroup {
  provider: string;
  count: number;
  kind: "provider" | "aggregator";
  /** Presentation only. Expand with modelFilter; never pass to agent(). */
  selector?: string;
  modelFilter: string;
}

export interface HarnessConfigSummaryEntry {
  backendId: string;
  /** Exact-model probe scope, when selected before reading options. */
  model?: string;
  probed: boolean;
  error?: string;
  hasModelOption: boolean;
  /** Actual complete live catalog size, before presentation limits/preferences. */
  total: number;
  /** Current selection is separate from preferred models; it need not be preferred. */
  currentModel?: string;
  /** Present only when the current model is an advertised executable leaf. */
  currentRoute?: string;
  omittedCurrentModel?: true;
  models: HarnessConfigSummaryModel[];
  omittedModels: number;
  groups: HarnessConfigSummaryGroup[];
  omittedGroups: number;
  omittedGroupModels: number;
  preferenceSource?: "enabledModels";
  /** Available preferred models before presentation limits. */
  preferredTotal?: number;
  unmatched: string[];
  omittedUnmatched: number;
}

export interface HarnessConfigSummary {
  /** One entry per requested probe, including unavailable backends, in request order. */
  harnesses: HarnessConfigSummaryEntry[];
}

function boundedLabel(value: string): string {
  return value.length <= MAX_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_VALUE_LENGTH)}… (${value.length - MAX_VALUE_LENGTH} characters omitted)`;
}

function display(value: string): string {
  return boundedLabel(redactText(value).value);
}

function providerOf(value: string): string {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "(ungrouped)";
}

function providerFilter(provider: string): string {
  return provider === "(ungrouped)"
    ? "/^[^/]+$/"
    : `/^${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\//`;
}

function preferences(value: unknown): { preferred: string[]; unmatched: string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Record<string, unknown>;
  if (meta.source !== "enabledModels" || !Array.isArray(meta.preferred) || !Array.isArray(meta.unmatched)) {
    return undefined;
  }
  if (!meta.preferred.every((id) => typeof id === "string") || !meta.unmatched.every((id) => typeof id === "string")) {
    return undefined;
  }
  return { preferred: meta.preferred as string[], unmatched: meta.unmatched as string[] };
}

/** Compact live authoring guidance. Does not mutate or restrict the supported catalog.
 * Lists are bounded per harness; omitted counts and exact expansion filters are explicit.
 * Options such as effort remain authoritative only for the exact probed model. */
export function buildHarnessConfigSummary(
  report: Pick<HarnessConfigReport, "harnessOptions">,
): HarnessConfigSummary {
  return {
    harnesses: report.harnessOptions.map((harness): HarnessConfigSummaryEntry => {
      const entry: HarnessConfigSummaryEntry = {
        backendId: boundedLabel(harness.backendId),
        ...(harness.model === undefined ? {} : { model: boundedLabel(harness.model) }),
        probed: harness.probed,
        ...(!harness.probed ? { error: display(harness.error ?? "unknown error") } : {}),
        hasModelOption: false,
        total: 0, models: [], omittedModels: 0, groups: [], omittedGroups: 0,
        omittedGroupModels: 0, unmatched: [], omittedUnmatched: 0,
      };
      if (!harness.probed) return entry;
      const model = harness.options?.find((option) => option.id === "model" && option.type === "select");
      if (!model || model.type !== "select") return entry;
      entry.hasModelOption = true;
      const ids = selectChoicePairs(model).map(({ value }) => value);
      entry.total = ids.length;
      if (model.currentValue) {
        const route = `${harness.backendId}/${model.currentValue}`;
        if (route.length <= MAX_VALUE_LENGTH) {
          entry.currentModel = model.currentValue;
          if (ids.includes(model.currentValue) && !model.currentValue.includes("*")) entry.currentRoute = route;
        } else entry.omittedCurrentModel = true;
      }
      const groups = new Map<string, number>();
      for (const id of ids) {
        const provider = providerOf(id);
        groups.set(provider, (groups.get(provider) ?? 0) + 1);
      }
      const isAggregator = (provider: string) =>
        harness.backendId === "opencode" && OPENCODE_AGGREGATORS.has(provider);
      // Stable sorting preserves catalog provider order within each classification.
      const orderedGroups = [...groups].sort(([a], [b]) => Number(isAggregator(a)) - Number(isAggregator(b)));
      for (const [provider, count] of orderedGroups) {
        if (entry.groups.length >= MAX_ENTRIES || provider.length > MAX_VALUE_LENGTH) {
          entry.omittedGroups++;
          entry.omittedGroupModels += count;
          continue;
        }
        entry.groups.push({
          provider, count,
          kind: isAggregator(provider) ? "aggregator" : "provider",
          ...(isAggregator(provider) ? { selector: `${provider}/*` } : {}),
          modelFilter: providerFilter(provider),
        });
      }
      const preferred = harness.backendId === "pi" ? preferences(model._meta?.[MODEL_DISCOVERY_META]) : undefined;
      let candidates: string[];
      if (preferred) {
        const available = new Set(ids);
        candidates = [...new Set(preferred.preferred)].filter((id) => available.has(id));
        entry.preferenceSource = "enabledModels";
        entry.preferredTotal = candidates.length;
        entry.unmatched = preferred.unmatched.slice(0, MAX_ENTRIES).map(display);
        entry.omittedUnmatched = preferred.unmatched.length - entry.unmatched.length;
      } else if (harness.backendId === "pi") {
        candidates = [];
      } else if (harness.backendId === "opencode") {
        // When direct catalogs exceed the display bound, represent each configured
        // direct provider before filling more rows from any one provider.
        const direct = new Map<string, string[]>();
        for (const id of ids) {
          const provider = providerOf(id);
          if (isAggregator(provider)) continue;
          const group = direct.get(provider) ?? [];
          group.push(id);
          direct.set(provider, group);
        }
        candidates = [];
        for (let index = 0; [...direct.values()].some((values) => index < values.length); index++) {
          for (const values of direct.values()) if (values[index] !== undefined) candidates.push(values[index]);
        }
      } else {
        candidates = ids.filter((id) => !isAggregator(providerOf(id)));
      }
      for (const id of candidates) {
        const route = `${harness.backendId}/${id}`;
        if (entry.models.length >= MAX_ENTRIES || route.length > MAX_VALUE_LENGTH || id.includes("*")) continue;
        entry.models.push({ modelId: id, route });
      }
      entry.omittedModels = entry.total - entry.models.length;
      return entry;
    }),
  };
}

/** Format the bounded summary for both explicit discovery and missing-route diagnostics. */
export function formatHarnessConfigSummary(summary: HarnessConfigSummary): string {
  const lines = ["authoring model summary:"];
  if (!summary.harnesses.length) lines.push("  (no harnesses requested)");
  for (const harness of summary.harnesses) {
    const label = harness.model ?? harness.backendId;
    if (!harness.probed) {
      lines.push(`  ${JSON.stringify(label)}: unavailable — ${JSON.stringify(harness.error)}`);
      continue;
    }
    if (!harness.hasModelOption) {
      lines.push(`  ${JSON.stringify(label)}: no model option advertised`);
      continue;
    }
    lines.push(`  ${JSON.stringify(label)}: ${harness.total} supported model(s)`);
    if (harness.currentModel !== undefined) {
      lines.push(`    current model: ${JSON.stringify(harness.currentRoute ?? harness.currentModel)}`);
    }
    if (harness.omittedCurrentModel) lines.push("    current model omitted by summary length limit; inspect the model config option");
    if (harness.preferenceSource) {
      lines.push(`    Pi enabledModels: ${harness.preferredTotal} available preferred model(s); presentation shortlist, not an execution allowlist`);
    } else if (harness.backendId === "pi") {
      lines.push("    No enabledModels preference metadata; showing available provider groups");
    }
    for (const model of harness.models) lines.push(`    model: ${JSON.stringify(model.route)}`);
    if (harness.omittedModels) lines.push(`    ${harness.omittedModels} supported model(s) not listed as exact routes here; expand with modelFilter`);
    for (const group of harness.groups) {
      lines.push(`    ${group.kind === "aggregator" ? "browse only (not executable)" : "provider"}: ${JSON.stringify(group.selector ?? group.provider)} (${group.count} models); modelFilter: ${JSON.stringify(group.modelFilter)}`);
    }
    if (harness.omittedGroups) lines.push(`    ${harness.omittedGroups} provider group(s), ${harness.omittedGroupModels} models omitted by summary limits; use config modelFilter`);
    if (harness.unmatched.length) lines.push(`    unmatched enabledModels patterns: ${harness.unmatched.map((value) => JSON.stringify(value)).join(", ")}`);
    if (harness.omittedUnmatched) lines.push(`    ${harness.omittedUnmatched} additional unmatched enabledModels pattern(s) omitted by summary limits`);
  }
  lines.push('  Browse wildcards are not executable. Expand with config harnesses:["<backend>"], modelFilter:"<substring or /regex/>"; use an exact returned leaf route in agent(prompt, { model }).');
  lines.push('  Default-model options do not describe every model. Probe config modelSpecs:["<exact route>"] before choosing mode/effort/configOptions. A backend-only model route explicitly selects its configured default.');
  return lines.join("\n");
}
