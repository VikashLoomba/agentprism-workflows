// ===== packages/shared-types/src/agent-run.ts =====
import type { Static, TSchema } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { McpServerConfig } from "./mcp-config.js";

/** Real token/cost usage for ONE subagent run. Delivered OUT-OF-BAND via
 *  RunOptions.onUsage — NEVER via run()'s return value. Fires on BOTH the success
 *  AND error paths (agent.ts:441-455) so partial usage is never lost. `total === 0`
 *  is the "provider reported nothing" sentinel -> the engine falls back to a chars/4
 *  estimate (workflow.ts:444). onUsage may NEVER fire at all (ACP usage is
 *  experimental) — every consumer tolerates usage === undefined.
 *
 *  ACP mapping (acp-agents fills this from PromptResponse.usage / usage_update,
 *  types.gen.d.ts:2943/2984, marked UNSTABLE):
 *    input      <- inputTokens          output     <- outputTokens
 *    cacheRead  <- cachedReadTokens ?? 0 cacheWrite <- cachedWriteTokens ?? 0
 *    total      <- totalTokens ?? 0      (0 => engine estimates)
 *    cost       <- Claude: total_cost_usd (USD) ; Codex: 0 (no dollar cost) */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * The opts side of the AgentRunner seam — exactly the bag the engine passes at
 * workflow.ts:465 (cast `as any` there; frozen-typed here). Inputs flow IN
 * (prompt/schema/model/tier/cwd/signal/instructions/tool policy); telemetry flows
 * OUT via the on* callbacks, NEVER via the return value.
 *
 * NAME = RunOptions (the Phase-1 deliverable name); `AgentRunOptions` is exported as
 * a lift-compat alias so ported pi engine code that imports the old name resolves.
 *
 * FIELD NAMES ARE FROZEN: the engine binds these by name through an `as any` cast
 * (workflow.ts:488), so a renamed field would NOT raise a compile error — it would
 * mis-bind at runtime. Engine-passed fields (13): label, schema, signal, instructions,
 * model, tier, toolNames, disallowedToolNames, cwd, onModelResolved, onModelFallback,
 * onUsage, onHistory. `maxSchemaRetries` is runner-internal (the engine never passes
 * it). Pi's `tools?: ToolDefinition[]` is DROPPED — a pi-coding-agent type with no ACP
 * analog (ACP injects tools via session/new mcpServers, not this field) and never
 * passed by the engine.
 */
export interface RunOptions<S extends TSchema | undefined = undefined> {
  /** Human label for logs/telemetry. NOT part of the resume identity hash. */
  label?: string;
  /** typebox schema. Present => result is Static<schema>; absent => result is text.
   *  KEPT as typebox: it is JSON.stringify'd into the resume hash (hashAgentCall,
   *  workflow.ts:1062), so its exact serialization is part of journal identity AND it
   *  already IS a JSON Schema object that feeds Claude outputFormat / Codex outputSchema
   *  downstream. Freeze the exact object handed to hashAgentCall; normalize for Codex on
   *  a COPY, never mutate the hashed value. */
  schema?: S;
  /** Extra system guidance (engine builds it from phase/agentType/isolation). NOT hashed. */
  instructions?: string;
  /** Engine-owned cancellation. The runner SHOULD wire this to the backend session cancel
   *  (ACP session/cancel) but MUST NOT implement its own timeout. */
  signal?: AbortSignal;
  /** Model spec (`provider/modelId` or bare `modelId`). Runner interprets: cross-provider =>
   *  which ACP server to spawn; within-provider => session config / Claude _meta model.
   *  Omitted => session default. */
  model?: string;
  /** Coarse tier ("small" | "medium" | "big"). Consulted only when `model` is unset; `model` wins. */
  tier?: string;
  /** Working directory (e.g. an isolated git worktree). ABSOLUTE. Maps to ACP session/new {cwd}. NOT hashed. */
  cwd?: string;
  /** Tool allow-list (agentType `tools`). Runner maps to ACP permission auto-responses / mode. */
  toolNames?: string[];
  /** Tool deny-list (agentType `disallowedTools`), applied after the allow-list. */
  disallowedToolNames?: string[];
  /** With `schema`: extra client-side repair turns before strict prose extraction. Leaf default 2.
   *  Runner-internal — the engine never passes it and it is NOT plumbed to the MCP tool. */
  maxSchemaRetries?: number;
  /** Real usage, read right before session disposal. Fires on success AND error. May never fire. */
  onUsage?: (usage: AgentUsage) => void;
  /** The actually-resolved concrete model id (display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** A requested model/tier/phase spec that wasn't found (fell back to the session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** A compact snapshot of this subagent's message/tool history (diagnostic only). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Client-provided MCP servers to attach to this run (ACP `session/new { mcpServers }`).
   *  ADDITIVE and NOT part of the resume identity hash (hashAgentCall) — it wires tools,
   *  not the logical call. Omitted/empty => the runner sends `mcpServers: []` (the default). */
  mcpServers?: McpServerConfig[];
}

/** The result side of the seam: schema => the validated object, no schema => text.
 *  NO wrapper — usage is separate (onUsage). Must be JSON-round-trippable.
 *  NAME = AgentResult (Phase-1 deliverable name); `AgentRunResult` is the lift-compat alias. */
export type AgentResult<S extends TSchema | undefined = undefined> = S extends TSchema ? Static<S> : string;

/** Lift-compat aliases over the Phase-1-canonical names (same types). Ported pi
 *  engine/runner code importing the old names still resolves. */
export type AgentRunOptions<S extends TSchema | undefined = undefined> = RunOptions<S>;
export type AgentRunResult<S extends TSchema | undefined = undefined> = AgentResult<S>;
