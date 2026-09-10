/**
 * The run notices a host conversation receives without polling: terminal outcomes and the inputs
 * a run is waiting on. One wording, two deliveries — the run-monitor App injects them as host
 * messages (`ui/src/model-messages.ts`), and a legacy-era session receives them as Claude Code
 * channel notifications (`channel-notifier.ts`). Pure by design: no Node or DOM imports, so the
 * same module bundles into the App. `scripts/ensure-run-monitor-html.mjs` hashes it with the UI
 * sources so a wording change regenerates the panel.
 */
import type { RunStatus } from "@automatalabs/shared-types";

export const RUN_NOTICE_MAX_CHARS = 1600;

export type RunNoticeKind = "terminal" | "paused" | "checkpoint" | "permission" | "setup";

export interface RunNotice {
  /** Stable per-run identity: one trigger, one id, so every delivery path dedupes on it. */
  id: string;
  kind: RunNoticeKind;
  /** The run status the notice describes. */
  status: RunStatus;
  /** One-message text, sent to the agent as is: what the run reported is what the agent reads. */
  text: string;
}

/** The subset of a persisted run event a terminal notice reads. */
export interface TerminalNoticeEvent {
  type: string;
  errorRecord?: { message?: string };
}

const TERMINAL_STATUS: Record<string, RunStatus> = {
  complete: "completed",
  error: "failed",
  stopped: "aborted",
};

export function terminalNoticeText(runId: string, event: TerminalNoticeEvent): string | undefined {
  switch (event.type) {
    case "complete":
      return `[workflow run ${runId}] Run completed. Its exact result is available.`;
    case "error":
      return `[workflow run ${runId}] Run failed${
        event.errorRecord?.message ? `: ${event.errorRecord.message}` : ""
      }.`;
    case "stopped":
      return `[workflow run ${runId}] Run stopped.`;
    default:
      return undefined;
  }
}

export function terminalNotice(
  runId: string,
  record: { streamId: string; seq: number; event: TerminalNoticeEvent },
): RunNotice | undefined {
  const text = terminalNoticeText(runId, record.event);
  const status = TERMINAL_STATUS[record.event.type];
  if (text === undefined || status === undefined) return undefined;
  return { id: `terminal:${record.streamId}:${record.seq}`, kind: "terminal", status, text };
}

export interface PausedNoticeInput {
  reason: string;
  checkpoint?: { callIndex: number; hash: string; kind: string };
  backendId?: string;
}

export function pausedNotice(runId: string, pause: PausedNoticeInput): RunNotice {
  const checkpoint = pause.checkpoint;
  if (checkpoint) {
    return {
      id: `checkpoint:${checkpoint.callIndex}:${checkpoint.hash}`,
      kind: "checkpoint",
      status: "paused",
      text: `[workflow run ${runId}] Checkpoint ${checkpoint.callIndex} needs an explicit ${checkpoint.kind} answer. The run is paused until it is answered.`,
    };
  }
  return {
    id: `paused:${pause.reason}:${pause.backendId ?? ""}`,
    kind: "paused",
    status: "paused",
    text: `[workflow run ${runId}] The run needs attention (${pause.reason}). Read its current status before continuing.`,
  };
}

export function permissionNotice(
  runId: string,
  permission: { permissionId: string; callIndex: number },
): RunNotice {
  return {
    id: `permission:${permission.permissionId}`,
    kind: "permission",
    status: "running",
    text: `[workflow run ${runId}] Permission is required for agent call ${permission.callIndex}. Inspect the pending request and choose one of its exact options.`,
  };
}

export function setupNotice(runId: string, request: { id: string; kind: string }): RunNotice {
  return {
    id: `setup:${request.id}`,
    kind: "setup",
    status: "pending",
    text: `[workflow run ${runId}] Setup needs ${request.kind}. Inspect and answer the exact pending setup request.`,
  };
}
