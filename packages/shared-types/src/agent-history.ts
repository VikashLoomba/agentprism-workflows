// ===== packages/shared-types/src/agent-history.ts =====
// Lifted VERBATIM from pi agent-history.ts (TYPES only; compactAgentHistory() is an
// acp-agents concern). Delivered diagnostically via RunOptions.onHistory; never gates
// the result. The runner builds it from the drained ACP session/update stream.
export type AgentHistoryRole = "user" | "assistant" | "tool";
export type AgentHistoryKind = "text" | "toolCall" | "toolResult" | "error";

export interface AgentHistoryEntry {
  role: AgentHistoryRole;
  kind: AgentHistoryKind;
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}
