// packages/mcp-server/src/workflow-tool-output.ts
//
// The MCP `workflow` tool OUTPUT. The host-facing WorkflowRunResult<T> (runId, status,
// result, meta, phases, agentCount, durationMs, tokenUsage?, logs, reason?, resetHint?)
// lives in @agentprism/shared-types — it is the engine's runWorkflow return PLUS the
// run-manager's terminal status trio (the engine seam at :465 stays unchanged; the
// manager composes status). THIS file declares the MINIMAL outputSchema the MCP SDK
// validates structuredContent against, and projects the full result onto it.
//
// When an outputSchema is declared, CallToolResult.structuredContent is MANDATORY and
// SDK-validated (verified mcp.d.ts:150-154 + types.js:1289). We pin only the durable,
// machine-readable core — {runId, status, result, tokenUsage?, logs?} — and ALSO emit a
// human-readable text content block alongside it.
import { z } from "zod";
import type { WorkflowRunResult } from "@agentprism/shared-types";

/** MINIMAL MCP outputSchema (registerTool `outputSchema`). Pins WorkflowRunResult's
 *  machine-readable core. status lets a host tell completed from paused (provider
 *  usage-limit / headless checkpoint -> resumable via resumeFromRunId) / failed /
 *  aborted WITHOUT parsing logs. */
export const workflowToolOutputShape = {
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  result: z.unknown(),
  tokenUsage: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
      cost: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  logs: z.array(z.string()).optional(),
} as const;

/** The validated structuredContent shape (z.infer of the object built from the shape). */
export interface WorkflowToolResult<T = unknown> {
  runId: string;
  status: WorkflowRunResult["status"];
  result: T;
  tokenUsage?: WorkflowRunResult["tokenUsage"];
  logs?: string[];
}

/**
 * Project the host-facing WorkflowRunResult<T> onto the minimal MCP structuredContent.
 * The manager already settled `status` (normal return -> "completed"; a thrown
 * PROVIDER_USAGE_LIMIT WorkflowError -> "paused" with reason/resetHint, persisted &
 * resumable via resumeFromRunId; abort -> "aborted"; any other non-recoverable throw ->
 * "failed"), so this is a pure narrowing — no re-derivation here.
 */
export function toWorkflowToolResult<T>(run: WorkflowRunResult<T>): WorkflowToolResult<T> {
  return {
    runId: run.runId,
    status: run.status,
    result: run.result,
    tokenUsage: run.tokenUsage,
    logs: run.logs,
  };
}
