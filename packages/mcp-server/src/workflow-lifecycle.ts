import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  parseWorkflowScript, probeHarnessConfig, redactText, validateWorkflowScript,
  type ExecOptions, type PersistedRunState, type ValidateHarnessOptions,
  type ValidatedAgentCall, type WorkflowAgentConfiguration, type WorkflowBackendConfig,
} from "@automatalabs/workflows";
import type { AgentRunner } from "@automatalabs/shared-types";
import { assertSelectedWorkflowModels, buildWorkflowAgentConfigurationPlan } from "./workflow-agent-configuration.js";
import { DEFAULT_BACKEND_ENV, discoverProjectDefaultBackend, workflowNeedsPinnedDefault } from "./default-backend.js";
import type { ProjectContext } from "./project-registry.js";
import { clampWorkflowInput, type WorkflowExecuteToolInput, type WorkflowSetupResponseToolInput } from "./workflow-tool-input.js";
import { validationText, workflowProbeRunner } from "./workflow-preflight.js";

/** Every MCP request has a finite transport budget; human input is durable run state. */
export const WORKFLOW_REQUEST_BOUND_MS = 45_000;
export const WORKFLOW_PREPARATION_BOUND_MS = 120_000;
const MAX_SCRIPT_BYTES = 1_048_576;

export interface WorkflowSetupRequest {
    id: string;
    kind: "backend-approval" | "agent-configuration";
    title: string;
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: false;
    };
}

export type WorkflowSetup = { state: "preparing" } | { state: "input-required"; request: WorkflowSetupRequest };

interface PreparationData extends Record<string, unknown> {
  canConfigureAgents: boolean;
  approvedKeys: string[];
  setup?: WorkflowSetupRequest;
  pendingBackendKey?: string;
  plan?: { calls: ValidatedAgentCall[]; harnesses: ValidateHarnessOptions[]; selectionHash: string };
  agentConfigurations?: Record<number, WorkflowAgentConfiguration>;
  selectedOccurrences?: number[];
  responses: Record<string, string>;
}

export function canonicalWorkflowJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalWorkflowJson(item)}`).join(",")}}`;
}

export function workflowOperation(input: { requestId: string }): { id: string; fingerprint: string } {
  return { id: input.requestId, fingerprint: createHash("sha256").update(canonicalWorkflowJson(input)).digest("hex") };
}

export async function boundWorkflowRequest<T>(operation: Promise<T>, ms = WORKFLOW_REQUEST_BOUND_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProtocolError(ProtocolErrorCode.InternalError,
        "Workflow request deadline reached. Inspect status or retry with the same requestId; accepted work continues.")), ms);
      timer.unref?.();
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function readAcceptedScript(input: WorkflowExecuteToolInput): string {
  if (input.script !== undefined) {
    if (Buffer.byteLength(input.script, "utf8") > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds 1 MiB");
    return input.script;
  }
  // Open once and check the same descriptor before reading: never block on a FIFO/device or
  // reread mutable path content after a lost acceptance acknowledgement.
  const descriptor = openSync(input.scriptPath!, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) throw new Error("scriptPath must identify a regular file of at most 1 MiB");
    const script = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) throw new Error("Workflow script exceeds 1 MiB");
    return script;
  } finally { closeSync(descriptor); }
}

function preparationData(state: PersistedRunState): PreparationData {
  const preparation = state.preparation;
  const data = preparation?.data as PreparationData | undefined;
  if (preparation?.format !== 1 || !data || typeof data.canConfigureAgents !== "boolean" || !Array.isArray(data.approvedKeys) || !data.responses) {
    throw new Error("Stored workflow preparation is incompatible; start a fresh run");
  }
  return data;
}

export function workflowSetup(state: PersistedRunState | null | undefined): WorkflowSetup | undefined {
  if (!state?.preparation || state.status !== "pending") return undefined;
  const data = preparationData(state);
  if (state.preparation.state === "preparing") return { state: "preparing" };
  if (!data.setup) throw new Error("Stored workflow setup request is missing");
  return { state: "input-required", request: data.setup };
}

function backendKey(name: string, config: WorkflowBackendConfig): string {
  return createHash("sha256").update(canonicalWorkflowJson({ name, command: config.command, args: config.args ?? [], env: config.env ?? {} })).digest("hex");
}

/** Project-owned driver: it never captures an MCP request, abort signal, or transport. */
export class WorkflowLifecycle {
  private readonly driving = new Set<string>();
  private readonly probeRunner: ReturnType<typeof workflowProbeRunner>;

  constructor(private readonly context: ProjectContext, private readonly runner: AgentRunner) {
    this.probeRunner = workflowProbeRunner(runner);
  }

  accept(input: WorkflowExecuteToolInput, canConfigureAgents: boolean): { runId: string; duplicate: boolean } {
    const operation = workflowOperation(input);
    const existing = this.context.manager.findAcceptedRun(operation);
    if (existing) {
      this.recover(existing.runId);
      return { runId: existing.runId, duplicate: true };
    }
    const script = readAcceptedScript(input);
    // Bounded structural parsing precedes acceptance. Mock evaluation, live catalog probes,
    // and human setup remain owned by the durable run created below.
    parseWorkflowScript(script);
    if (!this.context.activeRuns.reserve()) throw new Error("Workflow limit reached (4 active or preparing runs)");
    let reserved = true;
    try {
      const data: PreparationData = { canConfigureAgents, approvedKeys: [], responses: {} };
      const accepted = this.context.manager.prepareRun(script, input.args, {
        ...clampWorkflowInput(input), agent: this.runner, operation,
        preparation: { format: 1, state: "preparing", data, responses: data.responses },
      });
      if (!accepted.created) {
        // Another process may win between the first lookup and durable acceptance. A
        // duplicate receipt does not confer ownership or consume this daemon's slot.
        this.context.activeRuns.releaseReservation();
        reserved = false;
        this.recover(accepted.runId);
        return { runId: accepted.runId, duplicate: true };
      }
      this.context.activeRuns.hold(accepted.runId);
      reserved = false;
      this.schedule(accepted.runId);
      return { runId: accepted.runId, duplicate: !accepted.created };
    } catch (error) {
      if (reserved) this.context.activeRuns.releaseReservation();
      throw error;
    }
  }

  recover(runId: string): void {
    const state = this.context.manager.getPersistence().load(runId);
    if (!state?.preparation || state.status !== "pending") return;
    if (!this.context.activeRuns.has(runId)) {
      if (!this.context.activeRuns.reserve()) return;
      try {
        if (!this.context.manager.claimPreparedRun(runId)) {
          this.context.activeRuns.releaseReservation();
          return;
        }
        this.context.activeRuns.hold(runId);
      } catch (error) {
        this.context.activeRuns.releaseReservation();
        throw error;
      }
    }
    if (state.preparation.state === "preparing") this.schedule(runId);
  }

  respond(input: WorkflowSetupResponseToolInput): void {
    const manager = this.context.manager;
    const state = manager.getPersistence().load(input.runId);
    if (!state) throw new Error(`No workflow run found for ${input.runId}`);
    const fingerprint = createHash("sha256").update(canonicalWorkflowJson(input.response)).digest("hex");
    // Receipts survive execution admission so delayed retransmissions remain idempotent.
    const receipts = state.setupResponses;
    if (receipts?.[input.setupId] !== undefined) {
      if (receipts[input.setupId] !== fingerprint) throw new Error("Conflicting response for this workflow setup request");
      return;
    }
    const data = preparationData(state);
    if (data.responses[input.setupId] !== undefined) {
      if (data.responses[input.setupId] !== fingerprint) throw new Error("Conflicting response for this workflow setup request");
      return;
    }
    if (state.status !== "pending" || data.setup?.id !== input.setupId) throw new Error("Workflow setup request is no longer pending");
    const cancelSetup = (message: string) => {
      const settled = manager.settlePreparedRun(input.runId, "aborted", message, {
        responses: { [input.setupId]: fingerprint }, expectedRevision: state.preparationRevision,
      });
      if (!settled) throw new Error("Workflow setup is no longer owned by this execution owner");
      this.context.activeRuns.evict(input.runId);
    };
    if (input.response.action !== "accept") {
      cancelSetup(`Workflow setup was ${input.response.action === "decline" ? "declined" : "cancelled"}`);
      return;
    }
    if (data.setup.kind === "backend-approval" &&
      (Object.keys(input.response.content).length !== 1 || typeof input.response.content.approve !== "boolean")) {
      throw new Error("Backend approval requires exactly the boolean approve field");
    }
    if (data.setup.kind === "backend-approval" && input.response.content.approve === false) {
      cancelSetup("Workflow setup was declined");
      return;
    }
    // Receipt retries and explicit cancellation do not start work. Every accepted answer
    // must first own a reserved slot; updatePreparation cannot bypass a full recovery cap.
    this.recover(input.runId);
    if (!this.context.activeRuns.has(input.runId)) {
      throw new Error("Workflow setup requires an available active-run slot and ownership; retry after capacity is available");
    }
    if (input.response.action === "accept") {
      if (data.setup.kind === "backend-approval") {
        if (input.response.content.approve && data.pendingBackendKey) data.approvedKeys.push(data.pendingBackendKey);
        else {
          cancelSetup("Workflow setup was declined");
          return;
        }
      } else {
        if (!data.plan) throw new Error("Workflow setup is missing its exact advertised selection plan");
        const plan = buildWorkflowAgentConfigurationPlan(parseWorkflowScript(state.script).meta, data.plan.calls, data.plan.harnesses);
        if (!plan || plan.selectionHash !== data.plan.selectionHash) throw new Error("Stored workflow selection plan is incompatible");
        data.agentConfigurations = plan.parse(input.response.content);
        data.selectedOccurrences = plan.callIndexes;
      }
    }
    data.responses[input.setupId] = fingerprint;
    delete data.setup;
    delete data.pendingBackendKey;
    delete data.plan;
    this.save(input.runId, data, state.preparationRevision);
    this.schedule(input.runId);
  }

  private save(runId: string, data: PreparationData, revision?: number): void {
    this.context.manager.updatePreparation(runId, {
      format: 1, state: data.setup ? "input-required" : "preparing", data, responses: data.responses,
    }, revision);
  }

  private schedule(runId: string): void {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    // Cross the acceptance response boundary before beginning static/mock/probe work.
    setImmediate(() => {
      const revision = this.context.manager.getPersistence().load(runId)?.preparationRevision;
      let failed = false;
      void this.drive(runId).catch((error: unknown) => {
        failed = true;
        const current = this.context.manager.getPersistence().load(runId);
        if (current?.preparationRevision !== revision) return;
        if (this.context.manager.settlePreparedRun(runId, "failed", error instanceof Error ? error.message : String(error))) {
          this.context.activeRuns.evict(runId);
        }
      }).finally(() => {
        this.driving.delete(runId);
        const current = this.context.manager.getPersistence().load(runId);
        // A setup response may arrive while the previous stage's promise is settling.
        if (!failed && current?.status === "pending" && current.preparation?.state === "preparing") this.schedule(runId);
      }).catch((error: unknown) => {
        // A persistence fault while recording preparation failure must not crash the daemon.
        // Retain ownership/capacity; a later inspection can retry the still-pending stage.
        console.error(`[workflow-lifecycle] Unable to settle preparation ${runId}: ${redactText(error instanceof Error ? error.message : String(error)).value}`);
      });
    });
  }

  private async drive(runId: string): Promise<void> {
    const manager = this.context.manager;
    const state = manager.getPersistence().load(runId);
    if (!state?.preparation || state.status !== "pending" || state.preparation.state === "input-required") return;
    const revision = state.preparationRevision;
    const data = preparationData(state);
    const input = { ...state.limits, args: state.args };
    const script = state.script;
    // Timeout invalidates this entire driver generation. Late probe completion cannot admit it.
    let expired = false;
    const run = async () => {
      const staticValidation = await validateWorkflowScript(script, { args: input.args, dryRun: false });
      if (!staticValidation.ok) throw new Error(validationText(staticValidation));
      const backends = parseWorkflowScript(script).meta.backends;
      const allowed = ["1", "true"].includes(process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS?.trim().toLowerCase() ?? "");
      for (const [name, config] of Object.entries(backends ?? {})) {
        const key = backendKey(name, config);
        if (allowed || data.approvedKeys.includes(key)) continue;
        data.pendingBackendKey = key;
        data.setup = {
          id: randomUUID(), kind: "backend-approval", title: "Approve workflow backend",
          message: `Workflow wants to spawn custom ACP backend "${name}":\n${redactText(`${config.command} ${(config.args ?? []).join(" ")}`).value}\nEnvironment: ${redactText(JSON.stringify(config.env ?? {})).value}. Approve this command?`,
          requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve" } }, required: ["approve"], additionalProperties: false },
        };
        if (!expired) this.save(runId, data, revision);
        return;
      }
      const discovery = await validateWorkflowScript(script, {
        args: input.args, cwd: this.context.projectDir, maxAgents: input.maxAgents,
        timeoutMs: 30_000, probeConfig: false, loadSavedWorkflow: (name) => manager.resolveSavedWorkflow(name),
      });
      if (!discovery.ok) throw new Error(validationText(discovery));
      let agentConfigurations: ExecOptions["agentConfigurations"] = data.agentConfigurations;
      if (data.agentConfigurations !== undefined) {
        const harnesses = [...new Set([...(this.probeRunner.listBackends?.() ?? []), ...Object.keys(backends ?? {})])];
        const current = await probeHarnessConfig({ cwd: this.context.projectDir,
          ...(harnesses.length ? { harnesses } : {}), backends, probeRunner: this.probeRunner });
        assertSelectedWorkflowModels(data.selectedOccurrences ?? [], data.agentConfigurations, current.harnessOptions);
      }
      if (agentConfigurations === undefined && data.canConfigureAgents && discovery.dryRun?.agentCalls.some((call) => call.model === undefined)) {
        const configuredHarnesses = [...new Set([...(this.probeRunner.listBackends?.() ?? []), ...Object.keys(backends ?? {})])];
        const advertised = await probeHarnessConfig({ cwd: this.context.projectDir,
          ...(configuredHarnesses.length ? { harnesses: configuredHarnesses } : {}), backends, probeRunner: this.probeRunner });
        const calls = discovery.dryRun?.agentCalls ?? [];
        const plan = buildWorkflowAgentConfigurationPlan(staticValidation.parse.meta!, calls, advertised.harnessOptions);
        if (plan) {
          // Validator/probe records use optional undefined properties in memory. Persist the
          // actual JSON catalog representation, then rebuild this exact form on response.
          data.plan = JSON.parse(JSON.stringify({ calls, harnesses: advertised.harnessOptions,
            selectionHash: plan.selectionHash })) as PreparationData["plan"];
          data.setup = { id: randomUUID(), kind: "agent-configuration", title: plan.request.title,
            message: plan.request.message, requestedSchema: plan.request.requestedSchema };
          if (!expired) this.save(runId, data, revision);
          return;
        }
      }
      let defaultModel: string | undefined;
      if (agentConfigurations === undefined && workflowNeedsPinnedDefault(discovery)) {
        if (process.env[DEFAULT_BACKEND_ENV] !== undefined) defaultModel = this.probeRunner.defaultBackendId?.();
        else if (this.probeRunner.defaultBackendId && this.probeRunner.listBackends) {
          defaultModel = (await discoverProjectDefaultBackend(this.context, this.probeRunner)).backendId;
        }
      }
      const preflight = await validateWorkflowScript(script, {
        args: input.args, cwd: this.context.projectDir, maxAgents: input.maxAgents, timeoutMs: 30_000,
        defaultModel, agentConfigurations, requireAgentConfiguration: agentConfigurations !== undefined,
        probeRunner: this.probeRunner, loadSavedWorkflow: (name) => manager.resolveSavedWorkflow(name),
      });
      if (!preflight.ok) throw new Error(validationText(preflight));
      if (agentConfigurations === undefined) {
        const canonical: Record<number, WorkflowAgentConfiguration> = {};
        for (const call of preflight.dryRun?.agentCalls ?? []) {
          const model = call.model ?? defaultModel;
          if (!model) throw new Error(`Agent occurrence ${call.index} (${call.label}) has no resolved provider/model`);
          canonical[call.index] = { model, ...(call.mode === undefined ? {} : { mode: call.mode }),
            ...(call.configOptions === undefined ? {} : { configOptions: call.configOptions }) };
        }
        agentConfigurations = canonical;
      }
      const current = manager.getPersistence().load(runId);
      if (expired || !current?.preparation || current.status !== "pending" || current.preparationRevision !== revision) return;
      const started = manager.admitPreparedRun(runId, {
        agent: this.runner, defaultModel, agentConfigurations, requireAgentConfiguration: true,
        agentConfigurationSource: data.agentConfigurations ? "mcp-setup" : "mcp-routing",
        scriptBackends: backends, maxAgents: input.maxAgents, concurrency: input.concurrency, agentRetries: input.agentRetries,
      });
      this.context.activeRuns.track(runId, started.promise);
    };
    try { await boundWorkflowRequest(run(), WORKFLOW_PREPARATION_BOUND_MS); }
    catch (error) { expired = true; throw error; }
  }
}

const drivers = new WeakMap<ProjectContext, WorkflowLifecycle>();
export function workflowLifecycle(context: ProjectContext, runner: AgentRunner): WorkflowLifecycle {
  let driver = drivers.get(context);
  if (!driver) { driver = new WorkflowLifecycle(context, runner); drivers.set(context, driver); }
  return driver;
}
