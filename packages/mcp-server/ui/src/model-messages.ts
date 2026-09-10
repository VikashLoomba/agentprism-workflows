// Quiet selection context and explicit/required notifications are distinct host operations.
// Automatic delivery is arbitrated by the server across independent/reopened app instances.
// The wording and ids live in src/run-notices.ts, shared with the server's Claude Code channel
// delivery so both paths say exactly the same thing about a run.
import type { App } from "@modelcontextprotocol/ext-apps";
import type {
  PersistedRunEvent,
  RunEventLogRecord,
} from "@automatalabs/shared-types";
import {
  pausedNotice,
  permissionNotice,
  setupNotice,
  terminalNoticeText,
  type RunNotice,
} from "../../src/run-notices.js";
import type { NodeSelection } from "./GraphView.js";
import type { RunModel } from "./state.js";
import type { RunStatusSnapshot } from "./run-status.js";

export type MessageApp = Pick<
  App,
  "sendMessage" | "callServerTool" | "getHostCapabilities"
>;

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
    workflow: model.name ?? "workflow",
    status: status?.status ?? model.status,
    selection:
      selected?.kind === "agent"
        ? {
            kind: "agent",
            callIndex: selected.callIndex,
            label: node?.label ?? "unknown",
            status: node?.status,
            scope: node?.scope,
            error: node?.errorText ? node.errorText : undefined,
          }
        : selected?.kind === "phase"
        ? { kind: "phase", phaseIndex: selected.phaseIndex }
        : { kind: "run" },
    phase,
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
  return `[workflow monitor context] ${JSON.stringify(context)}`;
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
  return terminalNoticeText(runId, event);
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
      content: [{ type: "text", text }],
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
  const notices: RunNotice[] = [];
  if (status.setup?.request)
    notices.push(setupNotice(status.runId, status.setup.request));
  for (const request of status.pendingPermissions ?? [])
    notices.push(permissionNotice(status.runId, request));
  const checkpoint = status.checkpointContext;
  if (status.status === "paused" && checkpoint) {
    notices.push(
      pausedNotice(status.runId, { reason: "checkpoint_required", checkpoint }),
    );
  } else if (status.status === "paused" && status.pauseReason) {
    notices.push(
      pausedNotice(status.runId, {
        reason: status.pauseReason,
        backendId: status.authContext?.backendId,
      }),
    );
  }
  for (const notice of notices)
    void sendAutomaticMessage(app, status.runId, notice.id, notice.text, state);
}
