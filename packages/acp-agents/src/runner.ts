// AcpAgentRunner — the AgentRunner seam implementation (the LEAF the engine injects against).
// One method, two backend strategies behind it. Per run():
//   1. pick the backend by model/tier (cross-provider routing = which ACP server to spawn)
//   2. ACQUIRE a pooled connection + session/new { cwd } (per-session cwd = worktree isolation;
//      the PROCESS is pool-managed and REUSED across runs — never spawned/killed per run)
//   3. select the model via session/set_config_option (onModelResolved / onModelFallback)
//   4. apply the schema per backend (Claude: at session/new; Codex: per-turn _meta)
//   5. prompt + drain; enforce the tool allow/deny policy via permission auto-responses
//   6. schema  -> native -> validate -> re-prompt ladder -> SCHEMA_NONCOMPLIANCE
//      no schema -> final assistant text (empty -> AGENT_EMPTY_OUTPUT, recoverable)
//      provider wall (thrown) -> PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)
//      pooled process crash (thrown) -> recoverable AGENT_EXECUTION_ERROR (engine retries on a
//        fresh process; the dead connection is evicted from the pool)
//   7. usage -> onUsage on BOTH the success and error paths; honor opts.signal (-> session/cancel)
//   8. RELEASE the session (session/close) WITHOUT killing the process; return it to the pool
//
// Timeout and abort are the ENGINE's job: we honor opts.signal (wired to ACP session/cancel)
// and re-throw on abort, but never implement our own timeout.
import {
  WorkflowError,
  WorkflowErrorCode,
  type AgentResult,
  type AgentRunner,
  type RunOptions,
} from "@automatalabs/shared-types";
import type { StopReason } from "@agentclientprotocol/sdk";
import type { TSchema } from "typebox";
import type { SessionHandle } from "./acp-client.js";
import { AcpAgentPool, type AcpPoolOptions } from "./pool.js";
import type { Backend } from "./backend.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { mapThrownError } from "./errors-map.js";
import type { ToolPolicy } from "./permissions.js";
import { resolveStructuredOutput, type StructuredSession } from "./structured-output.js";

type AnyRunOptions = RunOptions<TSchema | undefined>;

export class AcpAgentRunner implements AgentRunner {
  private readonly pool: AcpAgentPool;

  constructor(options: AcpPoolOptions = {}) {
    this.pool = new AcpAgentPool(options);
  }

  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const opts = options as AnyRunOptions;
    const schema = opts.schema;
    const backend = selectBackend(opts);
    const policy: ToolPolicy = { allow: opts.toolNames, deny: opts.disallowedToolNames };
    const cwd = opts.cwd ?? process.cwd();

    const session: SessionHandle = await this.pool.acquire(backend, {
      cwd,
      schema,
      policy,
      signal: opts.signal,
      mcpServers: opts.mcpServers,
      // Engine correlation id -> session/new _meta (META_KEYS.runId). Additive; never hashed.
      runId: opts.runId,
    });
    try {
      opts.signal?.throwIfAborted();
      await applyModelSelection(session, opts);

      const text = buildPrompt(prompt, opts, Boolean(schema));
      const promptMeta = backend.promptMeta(schema);
      const response = await session.prompt(text, promptMeta);
      opts.signal?.throwIfAborted();
      // Inspect the turn's stop reason BEFORE the text/schema path: a refusal or truncation
      // must surface distinctly here, never be misread as empty output or burned through the
      // schema-repair ladder into SCHEMA_NONCOMPLIANCE.
      assertNormalStopReason(response.stopReason, opts.label);

      if (schema) {
        const structuredSession: StructuredSession = {
          prompt: async (repromptText: string) => {
            const repromptResponse = await session.prompt(repromptText, promptMeta);
            // A repair turn that refuses / truncates / cancels must also surface distinctly
            // instead of silently continuing the ladder.
            assertNormalStopReason(repromptResponse.stopReason, opts.label);
          },
          lastText: () => session.currentTurnText(),
          tryNative: () => backend.nativeStructured(session),
        };
        const result = await resolveStructuredOutput(structuredSession, schema, {
          maxSchemaRetries: opts.maxSchemaRetries,
          signal: opts.signal,
          label: opts.label,
        });
        return result as AgentResult<S>;
      }

      const finalText = session.currentTurnText().trim();
      if (!finalText) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: opts.label,
        });
      }
      return finalText as unknown as AgentResult<S>;
    } catch (error) {
      // Abort is the engine's concern (throwIfAborted before/after the call) — re-throw it raw.
      if (opts.signal?.aborted) throw error;
      throw mapThrownError(error, opts.label);
    } finally {
      // Read real usage on BOTH success and error so partial usage is never lost.
      try {
        opts.onUsage?.(session.usage.toAgentUsage());
      } catch {
        // usage is best-effort; never let it mask the real result/error.
      }
      try {
        opts.onHistory?.(session.history);
      } catch {
        // history is diagnostic only.
      }
      // Release the SESSION (best-effort session/close) WITHOUT killing the pooled process.
      try {
        await session.release();
      } catch {
        // release is best-effort (session already untracked); never mask the real result/error.
      }
    }
  }

  /** Tear down the whole pool (close every long-lived process). Call when the run ends / the
   *  runner is disposed. Beyond the AgentRunner seam (additive) — never enters the resume hash. */
  async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}

/** Factory the mcp-server composition root calls to inject the runner into the engine. The pool
 *  size is a runner-level option (default 1, else AGENTPRISM_ACP_POOL_SIZE) — NOT a RunOptions
 *  field, so it never enters hashAgentCall / the resume identity. */
export function createAcpRunner(options?: AcpPoolOptions): AgentRunner {
  return new AcpAgentRunner(options);
}

/**
 * Map a PromptResponse.stopReason onto the seam's error contract. `end_turn` (and any
 * unknown future reason) is a normal completion — fall through to the text/schema path.
 * The abnormal reasons each get a DISTINCT, non-recoverable failure so the engine never
 * retries a refused/truncated prompt (burning the retry budget) and never mistakes it for
 * recoverable empty output:
 *   - refusal             -> AGENT_EXECUTION_ERROR "model refused to respond"
 *   - max_tokens / max_turn_requests -> AGENT_EXECUTION_ERROR "output truncated"
 *   - cancelled           -> WORKFLOW_ABORTED
 */
function assertNormalStopReason(stopReason: StopReason, label?: string): void {
  switch (stopReason) {
    case "refusal":
      throw new WorkflowError("model refused to respond", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
        agentLabel: label,
      });
    case "max_tokens":
    case "max_turn_requests":
      throw new WorkflowError(
        `output truncated (stop reason: ${stopReason})`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    case "cancelled":
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: false,
        agentLabel: label,
      });
    default:
      // "end_turn" and any unrecognized future reason: normal completion.
      return;
  }
}

async function applyModelSelection(session: SessionHandle, opts: AnyRunOptions): Promise<void> {
  // `model` wins; `tier` is consulted only when `model` is unset (frozen contract).
  const spec = opts.model ?? opts.tier;
  if (!spec) return;
  const { matched, resolved, modifierFallbacks } = await session.selectModel(spec);
  if (matched) opts.onModelResolved?.(resolved ?? spec);
  else opts.onModelFallback?.(spec);
  // Symmetric to model fallback: a requested reasoning_effort / Fast-mode value the catalog
  // does not advertise is a silent no-op in the session. Surface it on the SAME channel so
  // incorrect tiering is observable (best-effort — reported, never thrown).
  for (const fallback of modifierFallbacks ?? []) opts.onModelFallback?.(fallback);
}

function buildPrompt(prompt: string, opts: AnyRunOptions, structured: boolean): string {
  const parts: string[] = [];
  if (opts.instructions) parts.push(opts.instructions);
  if (opts.label) parts.push(`Task label: ${opts.label}`);
  parts.push(prompt);
  if (structured) {
    parts.push(
      [
        "Final output contract:",
        "- Your FINAL message MUST be a single JSON object that conforms to the required output schema.",
        "- Output ONLY that JSON object — no prose, no explanation, and no markdown code fences.",
        "- If you need to inspect files or run commands first, do so, then emit the JSON object as your final message.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Pick the backend by model/tier. Cross-provider routing = which ACP server to spawn. */
export function selectBackend(opts: { model?: string; tier?: string }): Backend {
  const id = backendIdForSpec(opts.model) ?? backendIdForSpec(opts.tier) ?? defaultBackendId();
  return id === "codex" ? new CodexBackend() : new ClaudeBackend();
}

function backendIdForSpec(spec: string | undefined): "claude" | "codex" | undefined {
  if (!spec) return undefined;
  const lower = spec.toLowerCase();
  const slash = lower.indexOf("/");
  const provider = slash > 0 ? lower.slice(0, slash) : "";
  if (provider === "openai" || provider === "codex") return "codex";
  if (provider === "anthropic" || provider === "claude") return "claude";

  const id = slash > 0 ? lower.slice(slash + 1) : lower;
  if (/codex|gpt|openai|\bo\d/.test(id)) return "codex";
  if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "claude";
  return undefined;
}

function defaultBackendId(): "claude" | "codex" {
  return process.env.AGENTPRISM_DEFAULT_BACKEND?.toLowerCase() === "codex" ? "codex" : "claude";
}
