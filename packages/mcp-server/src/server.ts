// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the single SYNCHRONOUS `workflow` tool,
// and is the composition root where all three packages meet — the injected acp-agents
// AgentRunner is threaded into the workflow-engine run from inside the tool handler.
//
// Run model (frozen contract + ground-truth finding 5): one tools/call == one full run,
// awaited to completion (taskSupport:'forbidden' — a plain ToolCallback, never a task
// handler). Mid-run progress streams via notifications/progress; extra.signal threads
// cancellation into the engine; resumeFromRunId continues a paused run from its journal;
// checkpoint() is driven by the engine's `confirm` hook, wired here to server.elicitInput
// with a headless fallback when the host cannot elicit.
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { runWorkflow } from "@agentprism/workflow-engine";
import type { WorkflowRunOptions } from "@agentprism/workflow-engine";
import type { AgentRunner, RunStatus, WorkflowRunResult } from "@agentprism/shared-types";
import { WorkflowErrorCode, isWorkflowError } from "@agentprism/shared-types";

import { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
import { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
import type { WorkflowToolResult } from "./workflow-tool-output.js";
import { createProgressReporter } from "./progress.js";
import type { WorkflowProgressCallback } from "./progress.js";

const SERVER_NAME = "agentprism-workflow";
const SERVER_VERSION = "0.0.0";

/**
 * The options bag the shell hands to the engine's `runWorkflow`. It IS the frozen
 * `WorkflowRunOptions` seam (script + injected AgentRunner + args + signal) WIDENED with the
 * run-manager knobs the shell threads through from the validated/clamped MCP tool input and
 * the live protocol context: the numeric limits, the explicit resume identity, the progress
 * sink, and the human-in-the-loop confirm hook. The engine reads each field BY NAME.
 */
export interface EngineExecOptions extends WorkflowRunOptions {
  /** Stable id for this run, owned by the shell so a paused/failed run stays addressable for
   *  resume even when `runWorkflow` throws before returning a value. On a resume it is the
   *  incoming resumeFromRunId; on a fresh run a new uuid. */
  runId?: string;
  /** Resume a prior run from its persisted journal (the engine loads the journal for this id). */
  resumeFromRunId?: string;
  /** Clamped: max agents allowed in this run. */
  maxAgents?: number;
  /** Clamped to MAX_CONCURRENCY by the engine. */
  concurrency?: number;
  /** Clamped to MAX_AGENT_RETRIES by the engine. */
  agentRetries?: number;
  /** ms; null => no hard per-agent timeout (the engine owns timeout policy). */
  agentTimeoutMs?: number | null;
  /** null => no total-token budget. */
  tokenBudget?: number | null;
  /** Engine progress -> MCP notifications/progress. */
  onProgress?: WorkflowProgressCallback;
  /** Human-in-the-loop checkpoint hook (the engine's `options.confirm`). */
  confirm?: WorkflowConfirmCallback;
}

/**
 * The checkpoint metadata the engine forwards to `confirm` (workflow.ts checkpoint()). Only
 * `default` is consumed by the shell (the headless reply is `default ?? true`); any other
 * fields the engine attaches are carried opaquely.
 */
export interface WorkflowCheckpointOptions {
  default?: unknown;
  [key: string]: unknown;
}

/**
 * The engine's `options.confirm` shape: `await confirm(promptText, checkpointOptions)`. The
 * resolved value is the human's reply (truthy => proceed). The shell maps an MCP elicitation
 * result onto it, or returns the headless default when the host cannot elicit.
 */
export type WorkflowConfirmCallback = (
  prompt: string,
  options: WorkflowCheckpointOptions,
) => Promise<unknown>;

/**
 * Wire the engine's checkpoint `confirm` hook to MCP elicitation. If the connected host
 * advertises elicitation, request a one-field `approve` boolean via server.elicitInput and
 * map the tri-state result; otherwise (or if the form request throws because the host cannot
 * satisfy it) apply the headless default `default ?? true`. This is server->client and gated
 * on host capability, so the catch is the contract, not a guard against bugs.
 */
function createConfirm(server: Server): WorkflowConfirmCallback {
  return async (prompt, options) => {
    const headlessReply = (): unknown => options.default ?? true;

    // No elicitation capability advertised -> cannot prompt the human; reply headlessly.
    if (!server.getClientCapabilities()?.elicitation) {
      return headlessReply();
    }

    try {
      const elicited = await server.elicitInput({
        message: prompt,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: "Approve this checkpoint to let the workflow continue.",
            },
          },
          required: ["approve"],
        },
      });
      if (elicited.action === "accept") {
        const approve = elicited.content?.approve;
        return typeof approve === "boolean" ? approve : headlessReply();
      }
      // "decline" / "cancel": the human explicitly did not approve -> do not proceed.
      return false;
    } catch {
      // Host advertised elicitation but cannot satisfy a form request (or it failed):
      // degrade to the headless default rather than aborting the whole run.
      return headlessReply();
    }
  };
}

/** Terminal outcome of a run that threw, narrowed for the MCP envelope. */
interface FailureOutcome {
  result: WorkflowToolResult;
  summary: string;
  isError: boolean;
}

/**
 * Compose the terminal status the run-manager would have stamped, from a thrown error.
 * PROVIDER_USAGE_LIMIT => "paused" (resumable, carries resetHint); an abort (WORKFLOW_ABORTED
 * or a tripped signal) => "aborted"; anything else non-recoverable => "failed". paused is NOT
 * a tool error (it is a normal resumable outcome); failed/aborted are surfaced with isError.
 */
function composeFailure(error: unknown, runId: string, signal: AbortSignal): FailureOutcome {
  let status: RunStatus;
  let reason: string;
  let resetHint: string | undefined;

  if (isWorkflowError(error)) {
    reason = error.message;
    if (error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) {
      status = "paused";
      resetHint = error.resetHint;
    } else if (error.code === WorkflowErrorCode.WORKFLOW_ABORTED || signal.aborted) {
      status = "aborted";
    } else {
      status = "failed";
    }
  } else {
    reason = error instanceof Error ? error.message : String(error);
    status = signal.aborted ? "aborted" : "failed";
  }

  const result: WorkflowToolResult = { runId, status, result: undefined };
  return {
    result,
    summary: formatTerminalSummary(runId, status, reason, resetHint),
    isError: status === "failed" || status === "aborted",
  };
}

function formatCompletedSummary(run: WorkflowRunResult): string {
  const lines: string[] = [
    `Workflow "${run.meta.name}" completed.`,
    `runId: ${run.runId}`,
    `agents: ${run.agentCount}  duration: ${run.durationMs}ms`,
  ];
  if (run.phases.length > 0) {
    lines.push(`phases: ${run.phases.join(", ")}`);
  }
  if (run.tokenUsage) {
    lines.push(
      `tokens: ${run.tokenUsage.total} (input ${run.tokenUsage.input}, output ${run.tokenUsage.output})  cost: $${run.tokenUsage.cost}`,
    );
  }
  return lines.join("\n");
}

function formatTerminalSummary(
  runId: string,
  status: RunStatus,
  reason: string,
  resetHint: string | undefined,
): string {
  const lines: string[] = [`Workflow run ${status}.`, `runId: ${runId}`];
  if (reason) {
    lines.push(`reason: ${reason}`);
  }
  if (resetHint) {
    lines.push(`reset hint: ${resetHint}`);
  }
  if (status === "paused") {
    lines.push(
      `This run is resumable — call the workflow tool again with resumeFromRunId="${runId}" to continue from its journal.`,
    );
  }
  return lines.join("\n");
}

/**
 * Build the MCP server with the single `workflow` tool registered. The AgentRunner is the
 * DI seam: it is injected here and threaded into every engine run. The returned McpServer is
 * not yet connected — the caller attaches a transport (see index.ts / StdioServerTransport).
 */
export function createWorkflowServer(runner: AgentRunner): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  mcp.registerTool(
    "workflow",
    {
      title: "Run a dynamic agent workflow",
      description:
        "Execute a JavaScript workflow script to completion in a single synchronous call. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over the injected " +
        "ACP agent backend. Progress streams via notifications/progress when the client sends a " +
        "progressToken; pass resumeFromRunId to continue a paused run from its persisted journal.",
      inputSchema: workflowToolInputShape,
      outputSchema: workflowToolOutputShape,
    },
    async (args, extra) => {
      const input = clampWorkflowInput(args);
      // A fresh run gets a new id; a resume keeps the prior id so its journal is reused and the
      // returned runId stays stable across the pause/resume round-trip.
      const runId = input.resumeFromRunId ?? randomUUID();

      const engineOptions: EngineExecOptions = {
        script: input.script,
        agent: runner,
        args: input.args,
        signal: extra.signal,
        runId,
        resumeFromRunId: input.resumeFromRunId,
        maxAgents: input.maxAgents,
        concurrency: input.concurrency,
        agentRetries: input.agentRetries,
        agentTimeoutMs: input.agentTimeoutMs,
        tokenBudget: input.tokenBudget,
        onProgress: createProgressReporter(extra),
        confirm: createConfirm(mcp.server),
      };

      try {
        const engineResult = await runWorkflow(engineOptions);
        // The engine seam returns the host-facing result MINUS the terminal status trio; a
        // normal return is, by definition, "completed". (reason/resetHint stay unset.)
        const run: WorkflowRunResult = { ...engineResult, status: "completed" };
        const structuredContent = toWorkflowToolResult(run);
        return {
          structuredContent: { ...structuredContent },
          content: [{ type: "text", text: formatCompletedSummary(run) }],
        };
      } catch (error) {
        const failure = composeFailure(error, runId, extra.signal);
        return {
          structuredContent: { ...failure.result },
          content: [{ type: "text", text: failure.summary }],
          isError: failure.isError,
        };
      }
    },
  );

  return mcp;
}
