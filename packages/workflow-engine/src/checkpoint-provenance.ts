import { WorkflowError, WorkflowErrorCode } from "./errors.js";

const EXPLICIT_DECISION = "explicit-v1";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function incompatible(detail: string): never {
  throw new WorkflowError(
    `checkpoint-provenance-incompatible: ${detail}; start a fresh run and answer its checkpoints explicitly`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

/** Execution gate only: historical records remain available to read-only inspection. */
export function assertExplicitCheckpointDecision(value: unknown): void {
  if (!record(value) || value.checkpointDecision !== EXPLICIT_DECISION) {
    incompatible("a recorded checkpoint decision has missing or unsupported explicit-answer provenance");
  }
}

/** Check every retained execution source before reply classification or result reuse. */
export function assertExplicitCheckpointProvenance(source: unknown): void {
  if (!record(source)) return;
  const checkPending = (value: unknown): void => {
    if (!record(value)) return;
    if (Object.hasOwn(value, "default") || Object.hasOwn(value, "headless")) {
      incompatible("a pending checkpoint uses retired answer policies");
    }
  };
  const checkCall = (value: unknown): void => {
    if (!record(value) || value.kind !== "checkpoint") return;
    if (value.origin === "headless") incompatible("a checkpoint was resolved under a retired answer policy");
    if (value.outcome === "result") assertExplicitCheckpointDecision(value);
    else if (value.checkpointDecision !== undefined) incompatible("an unanswered checkpoint claims decision provenance");
    if (record(value.error)) checkPending(value.error.checkpointContext);
  };
  const checkEntry = (value: unknown): void => {
    if (!record(value)) return;
    if (value.kind === "checkpoint" || (record(value.call) && value.call.kind === "checkpoint")) {
      assertExplicitCheckpointDecision(value);
    }
  };
  checkPending(source.checkpointContext);
  for (const value of Array.isArray(source.calls) ? source.calls : []) checkCall(value);
  for (const value of Array.isArray(source.journal) ? source.journal : []) checkEntry(value);
  for (const value of Array.isArray(source.checkpointsTaken) ? source.checkpointsTaken : []) {
    if (!record(value) || !["live", "injected", "journal-replay"].includes(String(value.source))) {
      incompatible("checkpoint history contains an automatic or ambiguous answer");
    }
  }
  if (record(source.resumeSeed)) {
    for (const value of Array.isArray(source.resumeSeed.candidates) ? source.resumeSeed.candidates : []) {
      if (record(value)) { checkEntry(value.entry); checkCall(value.call); }
    }
    for (const value of Array.isArray(source.resumeSeed.callBlockers) ? source.resumeSeed.callBlockers : []) {
      if (record(value)) checkCall(value.call);
    }
    for (const value of Array.isArray(source.resumeSeed.checkpointInjections) ? source.resumeSeed.checkpointInjections : []) {
      assertExplicitCheckpointDecision(value);
    }
  }
}
