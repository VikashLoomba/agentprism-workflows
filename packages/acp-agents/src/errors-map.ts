// ACP failure -> WorkflowError{code, recoverable, resetHint}.
//
// Every hard backend failure REJECTS the ACP request (claude-agent-acp `failActive(...)`,
// codex-acp request errors), so the runner catches one thrown error and classifies it HERE.
// Provider usage/quota/rate walls are detected by running the thrown error's MESSAGE through
// classifyProviderLimit (shared-types) — this is the "gate on the error channel, never task
// text" rule: we only ever classify text that arrived via an error/reject, never the
// assistant's normal output. A matched wall becomes PROVIDER_USAGE_LIMIT (non-recoverable +
// resetHint -> the engine PAUSES and resumes instead of retrying into the same wall).
// Everything else is a recoverable AGENT_EXECUTION_ERROR (transient process/ACP faults that
// the engine retries). WorkflowErrors raised inside the ladder (SCHEMA_NONCOMPLIANCE,
// AGENT_EMPTY_OUTPUT) pass through unchanged.
import { classifyProviderLimit, isWorkflowError, WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Map any thrown error from the run path onto a seam-level WorkflowError. */
export function mapThrownError(error: unknown, label?: string): WorkflowError {
  // Already a seam error (e.g. SCHEMA_NONCOMPLIANCE / AGENT_EMPTY_OUTPUT raised in-band).
  if (isWorkflowError(error)) return error;

  const message = errorText(error);
  const { matched, resetHint } = classifyProviderLimit(message);
  if (matched) {
    return new WorkflowError(
      message || "Provider usage/quota limit reached",
      WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
      { recoverable: false, agentLabel: label, resetHint, details: error },
    );
  }

  return new WorkflowError(message || "Subagent execution failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: true,
    agentLabel: label,
    details: error,
  });
}
