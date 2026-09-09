// Browser-only projection of workflow's bounded status/control APIs. Keep Node server modules out
// of the single-file app bundle. Server schema/transport integration tests guard this seam.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { RunStatus } from "./state.js";

export interface PendingPermission {
  permissionId: string;
  runId: string;
  callIndex: number;
  backendId: string;
  label?: string;
  request: {
    toolCall: Record<string, unknown>;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
}

export interface CheckpointContext {
  callIndex: number;
  hash: string;
  prompt: string;
  kind: "confirm" | "input" | "select";
  choices?: string[];
}

export interface RunStatusSnapshot {
  runId: string;
  status: RunStatus;
  pauseReason?: string;
  checkpointContext?: CheckpointContext;
  pendingPermissions?: PendingPermission[];
  authContext?: { backendId: string };
  setup?: {
    state: "preparing" | "input-required";
    request?: {
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
    };
  };
}

export function resultError(result: {
  isError?: boolean;
  content?: unknown[];
}): void {
  if (!result.isError) return;
  const block = result.content?.find(
    (item) => typeof item === "object" && item !== null && "text" in item,
  ) as { text?: string } | undefined;
  throw new Error(
    block?.text ??
      "The server rejected this action. Refresh the run and try again.",
  );
}

export async function readRunStatus(
  app: Pick<App, "callServerTool">,
  runId: string,
): Promise<RunStatusSnapshot> {
  const result = await app.callServerTool({
    name: "workflow",
    arguments: { action: "status", runId, lastN: 1, logLines: 0 },
  });
  resultError(result);
  const status = result.structuredContent as unknown as
    | {
        runId: string;
        status: RunStatus;
        reason?: string;
        pendingPermissions?: PendingPermission[];
        setup?: RunStatusSnapshot["setup"];
        outcome?: {
          checkpointContext?: CheckpointContext;
          authContext?: { backendId: string };
        };
      }
    | undefined;
  if (status?.runId !== runId || typeof status.status !== "string")
    throw new Error("The server returned an invalid run status.");
  return {
    runId: status.runId,
    status: status.status,
    pauseReason: status.reason,
    checkpointContext: status.outcome?.checkpointContext,
    authContext: status.outcome?.authContext,
    pendingPermissions: status.pendingPermissions,
    setup: status.setup,
  };
}
