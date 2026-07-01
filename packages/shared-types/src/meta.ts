// ===== packages/shared-types/src/meta.ts =====
// RESERVED `_meta` namespaces. One source of truth so the Codex patch key and any
// engine correlation stamps never drift across packages.

/** OURS: the reserved ACP/MCP `_meta` namespace for every agentprism vendor extension. */
export const META_NS = "agentprism" as const;

/** Canonical `agentprism/*` keys the engine/runner read & write. */
export const META_KEYS = {
  /** Codex turn-level schema forward: the PATCHED codex-acp adapter reads
   *  request._meta["agentprism/outputSchema"] and threads it into turn/start.outputSchema. */
  outputSchema: `${META_NS}/outputSchema`,
  /** Run correlation passthrough on ACP requests, for tracing/telemetry. */
  runId: `${META_NS}/runId`,
} as const;

/** VENDOR (codex-acp) — NOT ours and NOT namespaced: bare `session/new` `_meta` keys the
 *  @automatalabs/codex-acp adapter reads and threads into the Codex `thread/start` /
 *  `thread/resume` / `thread/fork` params of the same name. Kept here (beside META_KEYS) so the
 *  writer (CodexBackend) and its tests never drift from the wire contract the fork reads. These
 *  deliberately live OUTSIDE META_NS — they mirror upstream codex-acp's bare-key convention
 *  (e.g. `additionalRoots`), not the reserved `agentprism/*` namespace. */
export const CODEX_META_KEYS = {
  /** Replaces Codex's built-in base system prompt for the thread. */
  baseInstructions: "baseInstructions",
  /** Injects developer-role instructions for the thread (added on top of the base prompt). */
  developerInstructions: "developerInstructions",
} as const;

/** VENDOR (claude-agent-acp) — NOT ours; the SDK's. Set at session/new for the Claude
 *  structured-output path: _meta.claudeCode.options.outputFormat = { type:"json_schema", schema }
 *  AND _meta.claudeCode.emitRawSDKMessages = true (MANDATORY — the parsed object lands on
 *  SDKResultSuccess.structured_output, readable ONLY off the raw _claude/sdkMessage notification).
 *  Typed here so the two namespaces never collide. */
export interface ClaudeJsonSchemaOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}
export interface ClaudeCodeSessionMeta {
  claudeCode?: {
    options?: { outputFormat?: ClaudeJsonSchemaOutputFormat; model?: string; [k: string]: unknown };
    emitRawSDKMessages?: boolean;
  };
}
