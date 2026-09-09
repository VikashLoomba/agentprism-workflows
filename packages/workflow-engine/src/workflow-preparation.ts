import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { cloneFrozenStrictJson } from "./strict-json.js";
import type { WorkflowContinuationResult } from "@automatalabs/shared-types";

/** Caller-owned retry identity. The fingerprint covers the operation's semantic input. */
export interface WorkflowOperationIdentity {
  id: string;
  fingerprint: string;
}

/** Engine-persisted, host-interpreted setup state. No transport or backend types cross this seam. */
export interface WorkflowPreparation {
  format: 1;
  state: "preparing" | "input-required";
  data: Record<string, unknown>;
  /** Content-free hashes of accepted host responses, retained after execution admission. */
  responses?: Record<string, string>;
}

export interface PersistedWorkflowContinuationOperation extends WorkflowOperationIdentity {
  acceptedAt: string;
  continuation: WorkflowContinuationResult;
}

/** Identities are never evicted: exceeding this limit refuses a new continuation. */
export const MAX_WORKFLOW_CONTINUATION_OPERATIONS = 4_096;
export const MAX_WORKFLOW_PREPARATION_BYTES = 1_048_576;

function invalid(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

export function captureWorkflowOperation(operation: WorkflowOperationIdentity): WorkflowOperationIdentity {
  if (
    operation === null || typeof operation !== "object" ||
    typeof operation.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operation.id) ||
    typeof operation.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(operation.fingerprint) ||
    Object.keys(operation).some((key) => key !== "id" && key !== "fingerprint")
  ) {
    throw invalid("workflow operation requires a bounded id and a lowercase SHA-256 fingerprint");
  }
  return Object.freeze({ id: operation.id, fingerprint: operation.fingerprint });
}

export function acceptedWorkflowRunId(projectDir: string, operation: WorkflowOperationIdentity): string {
  const captured = captureWorkflowOperation(operation);
  const hash = createHash("sha256")
    .update(JSON.stringify(["workflow-acceptance-v1", resolve(projectDir), captured.id]))
    .digest("hex");
  // A compact 128-bit identifier fits the existing public run-id vocabulary without
  // looking like an opaque credential in status/event projections. The full operation
  // fingerprint remains durable, so any identifier collision fails as a conflict.
  return `r-${BigInt(`0x${hash.slice(0, 32)}`).toString(36)}`;
}

export function assertWorkflowOperationMatches(
  recorded: WorkflowOperationIdentity | undefined,
  operation: WorkflowOperationIdentity,
): void {
  if (!recorded || recorded.id !== operation.id || recorded.fingerprint !== operation.fingerprint) {
    throw invalid(`workflow operation conflict: request identity "${operation.id}" already has different semantic input`);
  }
}

export function captureWorkflowPreparation(preparation: WorkflowPreparation): WorkflowPreparation {
  if (
    preparation === null || typeof preparation !== "object" ||
    preparation.format !== 1 ||
    (preparation.state !== "preparing" && preparation.state !== "input-required") ||
    preparation.data === null || typeof preparation.data !== "object" || Array.isArray(preparation.data) ||
    Object.keys(preparation).some((key) => key !== "format" && key !== "state" && key !== "data" && key !== "responses")
  ) {
    throw invalid("workflow preparation is incompatible: expected format 1 and preparing/input-required state");
  }
  let captured: ReturnType<typeof cloneFrozenStrictJson>;
  try {
    captured = cloneFrozenStrictJson(preparation);
  } catch {
    throw invalid("workflow preparation exceeds the supported strict-JSON structure");
  }
  if (!captured.ok) throw invalid(`workflow preparation is not strict JSON at ${captured.path}`);
  if (preparation.responses !== undefined) mergeWorkflowSetupResponses(undefined, preparation.responses);
  if (Buffer.byteLength(JSON.stringify(captured.clone), "utf8") > MAX_WORKFLOW_PREPARATION_BYTES) {
    throw invalid(`workflow preparation exceeds ${MAX_WORKFLOW_PREPARATION_BYTES} bytes`);
  }
  return captured.clone as unknown as WorkflowPreparation;
}

export function mergeWorkflowSetupResponses(
  previous: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (previous === undefined && incoming === undefined) return undefined;
  const merged: Record<string, string> = {};
  for (const responses of [previous, incoming]) {
    if (responses === undefined) continue;
    if (responses === null || typeof responses !== "object" || Array.isArray(responses)) {
      throw invalid("workflow setup response receipts must be a strict-JSON record");
    }
    for (const [id, fingerprint] of Object.entries(responses)) {
      captureWorkflowOperation({ id, fingerprint });
      if (Object.hasOwn(merged, id) && merged[id] !== fingerprint) {
        throw invalid(`workflow setup response conflict: request "${id}" was already answered`);
      }
      Object.defineProperty(merged, id, { value: fingerprint, enumerable: true, configurable: true });
    }
  }
  if (Object.keys(merged).length > MAX_WORKFLOW_CONTINUATION_OPERATIONS) {
    throw invalid(`workflow setup response limit ${MAX_WORKFLOW_CONTINUATION_OPERATIONS} reached`);
  }
  return Object.freeze(merged);
}
