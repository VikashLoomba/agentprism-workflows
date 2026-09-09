// Quiet selection context and explicit/required notifications are distinct host operations.
// Automatic delivery is arbitrated by the server across independent/reopened app instances.
import type { App } from "@modelcontextprotocol/ext-apps";
import type {
  PersistedRunEvent,
  RunEventLogRecord,
} from "@automatalabs/shared-types";
import type { NodeSelection } from "./GraphView.js";
import type { RunModel } from "./state.js";
import type { RunStatusSnapshot } from "./run-status.js";

export const CONTEXT_MAX_CHARS = 1600;
export type MessageApp = Pick<
  App,
  "sendMessage" | "callServerTool" | "getHostCapabilities"
>;

/** No transcript, prompt, source, or exact result is copied into automatic model context. */
function bounded(value: string, length: number): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi, "[redacted]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, length);
}

export function selectionContext(
  model: RunModel,
  selected?: NodeSelection,
  status?: RunStatusSnapshot,
): string {
  const node =
    selected?.kind === "agent"
      ? model.nodes.get(selected.callIndex)
      : undefined;
  const phase =
    selected?.kind === "phase"
      ? model.phases[selected.phaseIndex]
      : node?.phase ?? model.phases.at(-1);
  const context = {
    runId: model.runId,
    workflow: bounded(model.name ?? "workflow", 160),
    status: status?.status ?? model.status,
    selection:
      selected?.kind === "agent"
        ? {
            kind: "agent",
            callIndex: selected.callIndex,
            label: bounded(node?.label ?? "unknown", 160),
            status: node?.status,
            scope: node?.scope,
            error: node?.errorText ? bounded(node.errorText, 320) : undefined,
          }
        : selected?.kind === "phase"
        ? { kind: "phase", phaseIndex: selected.phaseIndex }
        : { kind: "run" },
    phase: phase ? bounded(phase, 160) : undefined,
    requiredInput: status?.setup?.request
      ? "setup"
      : status?.pendingPermissions?.length
      ? "permission"
      : status?.checkpointContext
      ? "checkpoint"
      : status?.pauseReason,
    activeAgents: [...model.nodes.values()].filter(
      (candidate) => candidate.status === "running",
    ).length,
  };
  return `[workflow monitor context] ${JSON.stringify(context)}`.slice(
    0,
    CONTEXT_MAX_CHARS,
  );
}

export function discussionMessage(
  model: RunModel,
  selected?: NodeSelection,
  status?: RunStatusSnapshot,
): string {
  return `Please discuss this workflow selection.\n${selectionContext(
    model,
    selected,
    status,
  )}`;
}

export interface ModelMessageState {
  /** Initial end cursor, including all pages of history; old terminal outcomes stay silent. */
  bootstrapEnd?: number;
  highWaterSeq: number;
  seen: Set<string>;
  viewId: string;
  active: boolean;
  isCurrent?: () => boolean;
  scopeId: Promise<string>;
}

function notificationScope(viewId: string): Promise<string> {
  const readOrCreate = () => {
    try {
      const key = "agentprism.workflow-notification-scope.v1";
      const current = localStorage.getItem(key);
      if (
        current &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          current,
        )
      )
        return current;
      const id = crypto.randomUUID();
      localStorage.setItem(key, id);
      return id;
    } catch {
      return viewId;
    }
  };
  // First opening in two same-origin frames must agree even when initialization is simultaneous.
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(
        "agentprism.workflow-notification-scope",
        readOrCreate,
      )
    : Promise.resolve(readOrCreate());
}

export function createModelMessageState(): ModelMessageState {
  const viewId = crypto.randomUUID();
  return {
    highWaterSeq: 0,
    seen: new Set(),
    viewId,
    active: true,
    scopeId: notificationScope(viewId),
  };
}

export function modelMessageText(
  runId: string,
  event: PersistedRunEvent,
): string | undefined {
  switch (event.type) {
    case "complete":
      return `[workflow run ${runId}] Run completed. Its exact result is available.`;
    case "error":
      return `[workflow run ${runId}] Run failed${
        event.errorRecord.message
          ? `: ${bounded(event.errorRecord.message, 320)}`
          : ""
      }.`;
    case "stopped":
      return `[workflow run ${runId}] Run stopped.`;
    default:
      return undefined;
  }
}

/** At-most-one active sender per event. A delivery/ack crash is inherently ambiguous to ui/message. */
export async function sendAutomaticMessage(
  app: MessageApp,
  runId: string,
  eventId: string,
  text: string,
  state: ModelMessageState,
): Promise<void> {
  if (
    !state.active ||
    state.isCurrent?.() === false ||
    !app.getHostCapabilities()?.message?.text ||
    state.seen.has(eventId)
  )
    return;
  state.seen.add(eventId);
  // Keep browser memory bounded. The shared server ledger survives view reconnect and panel replacement.
  if (state.seen.size > 256)
    state.seen.delete(state.seen.values().next().value!);
  let token: string | undefined;
  let delivered = false;
  const scopeId = await state.scopeId;
  if (!state.active || state.isCurrent?.() === false) return;
  try {
    const claim = await app.callServerTool({
      name: "workflow-notifications",
      arguments: {
        action: "claim",
        runId,
        eventId,
        viewId: state.viewId,
        scopeId,
      },
    });
    if (claim.isError) return;
    const lease = claim.structuredContent as
      | { send?: boolean; token?: string }
      | undefined;
    if (!lease?.send || typeof lease.token !== "string") return;
    token = lease.token;
    if (!state.active || state.isCurrent?.() === false) return;
    const response = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: text.slice(0, CONTEXT_MAX_CHARS) }],
    });
    if (response.isError) return;
    delivered = true;
  } catch {
    // Observation/actions remain available when this host rejects unsolicited delivery.
  } finally {
    if (token) {
      try {
        await app.callServerTool({
          name: "workflow-notifications",
          arguments: {
            action: delivered ? "sent" : "release",
            runId,
            eventId,
            viewId: state.viewId,
            scopeId,
            token,
          },
        });
      } catch {
        /* The short server lease bounds an unacknowledged delivery. */
      }
    }
  }
}

export function sendModelMessagesForFold(
  app: MessageApp,
  runId: string,
  pageAfter: number,
  records: readonly RunEventLogRecord[],
  state: ModelMessageState,
  endCursor = records.at(-1)?.seq ?? pageAfter,
): void {
  if (state.bootstrapEnd === undefined) state.bootstrapEnd = endCursor;
  for (const record of records) {
    if (record.seq <= state.highWaterSeq) continue;
    state.highWaterSeq = record.seq;
    if (record.seq <= state.bootstrapEnd) continue;
    const text = modelMessageText(runId, record.event);
    if (text)
      void sendAutomaticMessage(
        app,
        runId,
        `terminal:${record.streamId}:${record.seq}`,
        text,
        state,
      );
  }
}

export function sendRequiredInputMessages(
  app: MessageApp,
  status: RunStatusSnapshot,
  state: ModelMessageState,
): void {
  if (status.setup?.request) {
    void sendAutomaticMessage(
      app,
      status.runId,
      `setup:${status.setup.request.id}`,
      `[workflow run ${status.runId}] Setup needs ${status.setup.request.kind}. Inspect and answer the exact pending setup request.`,
      state,
    );
  }
  for (const request of status.pendingPermissions ?? []) {
    void sendAutomaticMessage(
      app,
      status.runId,
      `permission:${request.permissionId}`,
      `[workflow run ${status.runId}] Permission is required for agent call ${request.callIndex}. Inspect the pending request and choose one of its exact options.`,
      state,
    );
  }
  const checkpoint = status.checkpointContext;
  if (status.status === "paused" && checkpoint) {
    void sendAutomaticMessage(
      app,
      status.runId,
      `checkpoint:${checkpoint.callIndex}:${checkpoint.hash}`,
      `[workflow run ${status.runId}] Checkpoint ${checkpoint.callIndex} needs an explicit ${checkpoint.kind} answer. The run is paused until it is answered.`,
      state,
    );
  } else if (status.status === "paused" && status.pauseReason) {
    void sendAutomaticMessage(
      app,
      status.runId,
      `paused:${status.pauseReason}:${status.authContext?.backendId ?? ""}`,
      `[workflow run ${status.runId}] The run needs attention (${bounded(
        status.pauseReason,
        100,
      )}). Read its current status before continuing.`,
      state,
    );
  }
}
