import type { AgentRunner } from "@automatalabs/shared-types";
const BUILTIN_BACKEND_IDS = ["claude", "codex", "opencode", "pi"] as const;
import {
  buildHarnessModelsView,
  collapseHarnessOptionsForOutput,
  formatHarnessConfigReport,
  formatValidateReport,
  truncateUtf8,
  type CustomBackendConfig,
  type HarnessConfigReport,
  type ProbedConfigOptions,
  type ValidateProbeRunner,
  type ValidateWorkflowReport,
} from "@automatalabs/workflows";

const MAX_STRUCTURED_BYTES = 24_576;
const MAX_HARNESSES = 32;
const MAX_OPTIONS_PER_HARNESS = 48;
const MAX_MODEL_MATCHES = 100;
const MAX_TEXT_BYTES = 8_192;
const MAX_STRING_BYTES = 512;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_KEYS = 48;
const MAX_VALUE_ITEMS = 48;

export interface WorkflowConfigSummary {
  [key: string]: unknown;
  action: "config";
  ok: boolean;
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
  models: Array<Record<string, unknown>>;
}

interface ProbeRunnerCandidate {
  probeConfigOptions?: (
    spec?: string,
    options?: { cwd?: string; selectModel?: boolean; backends?: Record<string, CustomBackendConfig>; signal?: AbortSignal },
  ) => Promise<ProbedConfigOptions>;
  listBackends?: () => string[];
  listCustomBackends?: () => string[];
  defaultBackendId?: () => string;
}

/** Reuse the server's live runner for no-prompt discovery. A generic AgentRunner that does
 * not implement discovery reports that limitation per harness instead of spawning a second,
 * differently configured runner behind the host's back. */
export function workflowProbeRunner(runner: AgentRunner): ValidateProbeRunner {
  const candidate = runner as AgentRunner & ProbeRunnerCandidate;
  const listBackends =
    typeof candidate.listBackends === "function"
      ? () => candidate.listBackends!()
      : () => [...BUILTIN_BACKEND_IDS];
  if (typeof candidate.probeConfigOptions === "function") {
    return {
      probeConfigOptions: (spec, options) => candidate.probeConfigOptions!(spec, options),
      listBackends,
      ...(typeof candidate.listCustomBackends === "function"
        ? { listCustomBackends: () => candidate.listCustomBackends!() }
        : {}),
      ...(typeof candidate.defaultBackendId === "function"
        ? { defaultBackendId: () => candidate.defaultBackendId!() }
        : {}),
    };
  }
  return {
    listBackends,
    async probeConfigOptions() {
      throw new Error("this workflow server's runner does not expose no-prompt config discovery");
    },
  };
}

export function validationText(report: ValidateWorkflowReport): string {
  return truncateUtf8(
    `Workflow preparation validation failed. The accepted run remains available for inspection.\n\n${formatValidateReport(report)}`,
    MAX_TEXT_BYTES,
    "…[validation diagnostics truncated]",
  );
}

export function configSummary(report: HarnessConfigReport, modelFilter?: string): WorkflowConfigSummary {
  const projected = projectHarnessOptions(report.harnessOptions);
  const views = buildHarnessModelsView(report, modelFilter).map((view) => {
    const matches = view.matches ?? [];
    return boundValue({
      backendId: view.backendId,
      probed: view.probed,
      error: view.error,
      hasModelOption: view.hasModelOption,
      filter: view.filter,
      total: view.total,
      groups: view.groups,
      matches: matches.slice(0, MAX_MODEL_MATCHES),
      matchCount: matches.length,
      omittedMatches: Math.max(0, matches.length - MAX_MODEL_MATCHES),
    }) as Record<string, unknown>;
  });
  const summary: WorkflowConfigSummary = {
    action: "config",
    ok: report.ok,
    ...projected,
    models: views,
  };
  while (jsonBytes(summary) > MAX_STRUCTURED_BYTES) {
    const harness = summary.harnessOptions.find((entry) =>
      Array.isArray(entry.options) && entry.options.length > 0
    );
    if (harness && Array.isArray(harness.options)) {
      harness.options.pop();
      harness.omittedOptions = Number(harness.omittedOptions ?? 0) + 1;
      continue;
    }
    const model = summary.models.find((entry) => Array.isArray(entry.matches) && entry.matches.length > 0);
    if (model && Array.isArray(model.matches)) {
      model.matches.pop();
      model.omittedMatches = Number(model.omittedMatches ?? 0) + 1;
      continue;
    }
    const grouped = summary.models.find((entry) => Array.isArray(entry.groups) && entry.groups.length > 0);
    if (grouped && Array.isArray(grouped.groups)) {
      grouped.groups.pop();
      continue;
    }
    break;
  }
  return summary;
}

function routedModelSpec(backendId: string, modelId: string): string {
  return modelId.startsWith(`${backendId}/`) ? modelId : `${backendId}/${modelId}`;
}

function modelProbeSuggestion(
  report: HarnessConfigReport,
  failed: HarnessConfigReport["harnessOptions"][number],
): { filter: string; matches: string[]; omittedMatches: number } | undefined {
  if (failed.probed || !failed.model) return undefined;
  const rawModel = failed.model.startsWith(`${failed.backendId}/`)
    ? failed.model.slice(failed.backendId.length + 1)
    : failed.model;
  const filters = [...new Set([rawModel, rawModel.split("/").at(-1)].filter((value): value is string =>
    typeof value === "string" && value.length > 0))];
  const baseReport: HarnessConfigReport = {
    ...report,
    harnessOptions: report.harnessOptions.filter((harness) =>
      harness.probed && harness.backendId === failed.backendId && harness.model === undefined),
  };
  for (const filter of filters) {
    const matches = buildHarnessModelsView(baseReport, filter)[0]?.matches ?? [];
    if (matches.length > 0) {
      return {
        filter,
        matches: matches.slice(0, MAX_MODEL_MATCHES).map((modelId) =>
          routedModelSpec(failed.backendId, modelId)),
        omittedMatches: Math.max(0, matches.length - MAX_MODEL_MATCHES),
      };
    }
  }
  return undefined;
}

export function configText(report: HarnessConfigReport, modelFilter?: string): string {
  const lines = ["Live workflow backend configuration (no workflow was started):"];
  for (const harness of report.harnessOptions) {
    const suggestion = modelProbeSuggestion(report, harness);
    if (!suggestion) continue;
    lines.push(
      `${harness.model}: suggested exact modelSpecs: ` +
        suggestion.matches.map((match) => JSON.stringify(match)).join(", ") +
        (suggestion.omittedMatches > 0 ? ` (+${suggestion.omittedMatches} more)` : ""),
      `Discover similar models with modelFilter: ${JSON.stringify(suggestion.filter)}`,
    );
  }
  lines.push(formatHarnessConfigReport(report));
  if (modelFilter !== undefined) {
    const views = buildHarnessModelsView(report, modelFilter);
    for (const view of views) {
      if (!view.probed) continue;
      const matches = view.matches ?? [];
      lines.push(
        `${view.backendId}: ${matches.length} model(s) match ${JSON.stringify(modelFilter)}`,
        ...matches.slice(0, MAX_MODEL_MATCHES).map((model) => `  ${model}`),
      );
      if (matches.length > MAX_MODEL_MATCHES) lines.push(`  … ${matches.length - MAX_MODEL_MATCHES} more omitted`);
    }
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES, "…[config diagnostics truncated]");
}

function projectHarnessOptions(harnesses: readonly unknown[]): {
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
} {
  const collapsed = collapseHarnessOptionsForOutput(harnesses as Parameters<typeof collapseHarnessOptionsForOutput>[0]) ?? [];
  const harnessOptions = collapsed.slice(0, MAX_HARNESSES).map((raw) => {
    const harness = raw as {
      backendId: string;
      defaultModeId?: string;
      model?: string;
      probed: boolean;
      error?: string;
      modes?: unknown;
      options?: unknown[];
    };
    const options = harness.options ?? [];
    return boundValue({
      backendId: harness.backendId,
      defaultModeId: harness.defaultModeId,
      model: harness.model,
      probed: harness.probed,
      error: harness.error,
      modes: harness.modes,
      options: options.slice(0, MAX_OPTIONS_PER_HARNESS),
      omittedOptions: Math.max(0, options.length - MAX_OPTIONS_PER_HARNESS),
    }) as Record<string, unknown>;
  });
  return {
    harnessOptions,
    omittedHarnesses: Math.max(0, collapsed.length - MAX_HARNESSES),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundText(value: string): string {
  return truncateUtf8(value, MAX_STRING_BYTES, "…");
}

function boundValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundText(value);
  if (value === undefined) return undefined;
  if (depth >= MAX_VALUE_DEPTH) return "[depth bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_VALUE_ITEMS).map((item) => boundValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_VALUE_KEYS)) {
      const bounded = boundValue(item, depth + 1);
      if (bounded !== undefined) output[boundText(key)] = bounded;
    }
    return output;
  }
  return boundText(String(value));
}
