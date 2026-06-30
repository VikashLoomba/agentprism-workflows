// @agentprism/shared-types — the ONLY module BOTH workflow-engine and acp-agents
// import (they never import each other; mcp-server is the sole composition root).
// Zero Pi / ACP / MCP deps; depends only on `typebox` (type-level for TSchema/Static)
// + carries the WorkflowError RUNTIME class so `instanceof` holds across packages.
// Presented as the package's files, each compilable on its own.

// ===== packages/shared-types/src/errors.ts =====
// The seam-level ERROR contract. Lives HERE (not in the engine) because the runner
// (acp-agents) THROWS these and the engine reads .code + .recoverable via instanceof —
// both sides MUST import the SAME class. Lifted VERBATIM from pi errors.ts (enum +
// class + guard). wrapError/classifyProviderLimit stay engine-local (engine concern).
export enum WorkflowErrorCode {
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /** Provider subscription/usage/quota/rate limit. Non-recoverable => engine PAUSES (resumable), not failed. Carries resetHint. */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A schema agent never produced valid structured output (after repair + extraction). Non-recoverable. */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed with no assistant text. Recoverable. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  UNKNOWN = "UNKNOWN",
}

export interface WorkflowErrorOptions {
  recoverable?: boolean;
  agentLabel?: string;
  details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  readonly resetHint?: string;

  constructor(message: string, code: WorkflowErrorCode, options: WorkflowErrorOptions = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
  }
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}
