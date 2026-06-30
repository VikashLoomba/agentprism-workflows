// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the single SYNCHRONOUS `workflow` tool,
// and is the composition root where all three packages meet — the injected acp-agents
// AgentRunner is wired into a workflow-engine WorkflowManager (DI) and every tool call runs
// through WorkflowManager.runSync.
//
// Run model (frozen contract + ground-truth finding 5): one tools/call == one full run,
// awaited to completion (taskSupport:'forbidden' — a plain ToolCallback, never a task
// handler). The engine OWNS run identity, status stamping, and resume:
//   - runSync RESOLVES to a TERMINAL WorkflowRunResult (status completed|paused|failed|
//     aborted, carrying reason/resetHint) and does NOT throw on pause/fail/abort — so the
//     shell does no status composition and needs no lifecycle try/catch.
//   - resumeFromRunId is mapped to the engine's own persisted journal (manager persistence
//     loads it) and handed back as exec.resumeJournal; the engine replays the unchanged
//     prefix. The shell no longer owns/forges a runId.
// Mid-run progress streams via notifications/progress; extra.signal threads cancellation into
// the engine; checkpoint() is driven by the engine's `confirm` hook, wired here to
// server.elicitInput with a headless fallback when the host cannot elicit.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { WorkflowManager } from "@automatalabs/workflows";
import type {
  ExecOptions,
  WorkflowSnapshot,
  AgentRunner,
  JournalEntry,
  WorkflowRunResult,
} from "@automatalabs/workflows";

import { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
import { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
import { createProgressReporter } from "./progress.js";

const SERVER_NAME = "agentprism-workflow";
const SERVER_VERSION = "0.0.0";

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
 * The engine's `confirm` hook (ExecOptions.confirm): `await confirm(promptText, options)`.
 * The resolved value is the human's reply (truthy => proceed). The shell maps an MCP
 * elicitation result onto it, or returns the headless default when the host cannot elicit.
 */
export type WorkflowConfirmCallback = NonNullable<ExecOptions["confirm"]>;

/** Read the checkpoint `default` from the opaque options bag the engine forwards. */
function readCheckpointDefault(options: unknown): unknown {
  if (options && typeof options === "object" && "default" in options) {
    return (options as WorkflowCheckpointOptions).default;
  }
  return undefined;
}

/**
 * Wire the engine's checkpoint `confirm` hook to MCP elicitation. If the connected host
 * advertises elicitation, request a one-field `approve` boolean via server.elicitInput and
 * map the tri-state result; otherwise (or if the form request throws because the host cannot
 * satisfy it) apply the headless default `default ?? true`. This is server->client and gated
 * on host capability, so the catch is the contract, not a guard against bugs.
 */
function createConfirm(server: Server): WorkflowConfirmCallback {
  return async (prompt, options) => {
    const headlessReply = (): unknown => readCheckpointDefault(options) ?? true;

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

/** Human-readable summary for a completed run. */
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

/**
 * Human-readable summary for a terminal non-completed run (paused | failed | aborted). The
 * engine already stamped status/reason/resetHint on the WorkflowRunResult; this is a pure
 * projection — no status is re-derived here.
 */
function formatTerminalSummary(run: WorkflowRunResult): string {
  const lines: string[] = [`Workflow run ${run.status}.`, `runId: ${run.runId}`];
  if (run.reason) {
    lines.push(`reason: ${run.reason}`);
  }
  if (run.resetHint) {
    lines.push(`reset hint: ${run.resetHint}`);
  }
  if (run.status === "paused") {
    lines.push(
      `This run is resumable — call the workflow tool again with resumeFromRunId="${run.runId}" to continue from its journal.`,
    );
  }
  return lines.join("\n");
}

function formatRunSummary(run: WorkflowRunResult): string {
  return run.status === "completed" ? formatCompletedSummary(run) : formatTerminalSummary(run);
}

/**
 * Build the MCP server with the single `workflow` tool registered. The AgentRunner is the
 * DI seam: it is injected here into a single WorkflowManager (so persistence — and therefore
 * resume — is shared across calls) and every run goes through manager.runSync. The returned
 * McpServer is not yet connected — the caller attaches a transport (see index.ts).
 */
export function createWorkflowServer(runner: AgentRunner): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. The
  // manager owns run lifecycle, status stamping, and the persisted journal used by resume.
  const manager = new WorkflowManager({ agent: runner });

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
      const reporter = createProgressReporter(extra);

      const exec: ExecOptions = {
        signal: extra.signal,
        maxAgents: input.maxAgents,
        concurrency: input.concurrency,
        agentRetries: input.agentRetries,
        agentTimeoutMs: input.agentTimeoutMs,
        tokenBudget: input.tokenBudget,
        // The engine drives progress with the live snapshot; project it onto the MCP wire
        // shape (settled agents / total seen so far / current phase). `settled` is monotonic.
        onProgress: (snapshot: WorkflowSnapshot) => {
          const settled = snapshot.agents.filter(
            (a) => a.status === "done" || a.status === "error" || a.status === "skipped",
          ).length;
          reporter(settled, snapshot.agents.length || undefined, snapshot.currentPhase);
        },
        confirm: createConfirm(mcp.server),
      };

      // Resume: the engine owns run identity. The shell only re-hydrates the journal the
      // engine persisted for the prior runId and hands it back as resumeJournal; the engine
      // replays the unchanged prefix and runs the rest live.
      if (input.resumeFromRunId) {
        const persisted = manager.getPersistence().load(input.resumeFromRunId);
        if (persisted?.journal) {
          exec.resumeJournal = new Map<number, JournalEntry>(
            persisted.journal.map((entry) => [entry.index, entry] as const),
          );
        }
      }

      // runSync RESOLVES to a terminal WorkflowRunResult (status already stamped); it does not
      // throw on pause/fail/abort, so there is no shell-side status composition. A malformed
      // script throws BEFORE a run exists (no runId) — that propagates to the SDK, which
      // surfaces it as a tool error.
      const run = await manager.runSync(input.script, input.args, exec);

      const structuredContent = toWorkflowToolResult(run);
      const isError = run.status === "failed" || run.status === "aborted";
      return {
        structuredContent: { ...structuredContent },
        content: [{ type: "text", text: formatRunSummary(run) }],
        isError,
      };
    },
  );

  return mcp;
}
