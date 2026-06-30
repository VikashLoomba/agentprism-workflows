// AcpAgentRunner — the AgentRunner seam implementation (the LEAF the engine injects against).
// One method, two backend strategies behind it. Per run():
//   1. pick the backend by model/tier (cross-provider routing = which ACP server to spawn)
//   2. session/new { cwd } on a fresh subprocess (worktree isolation)
//   3. select the model via session/set_config_option (onModelResolved / onModelFallback)
//   4. apply the schema per backend (Claude: at session/new; Codex: per-turn _meta)
//   5. prompt + drain; enforce the tool allow/deny policy via permission auto-responses
//   6. schema  -> native -> validate -> re-prompt ladder -> SCHEMA_NONCOMPLIANCE
//      no schema -> final assistant text (empty -> AGENT_EMPTY_OUTPUT, recoverable)
//      provider wall (thrown) -> PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)
//   7. usage -> onUsage on BOTH the success and error paths; honor opts.signal (-> session/cancel)
//
// Timeout and abort are the ENGINE's job: we honor opts.signal (wired to ACP session/cancel)
// and re-throw on abort, but never implement our own timeout.
import {
  WorkflowError,
  WorkflowErrorCode,
  type AgentResult,
  type AgentRunner,
  type RunOptions,
} from "@agentprism/shared-types";
import type { TSchema } from "typebox";
import { AcpAgentSession } from "./acp-client.js";
import type { Backend } from "./backend.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { mapThrownError } from "./errors-map.js";
import type { ToolPolicy } from "./permissions.js";
import { resolveStructuredOutput, type StructuredSession } from "./structured-output.js";

type AnyRunOptions = RunOptions<TSchema | undefined>;

export class AcpAgentRunner implements AgentRunner {
  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const opts = options as AnyRunOptions;
    const schema = opts.schema;
    const backend = selectBackend(opts);
    const policy: ToolPolicy = { allow: opts.toolNames, deny: opts.disallowedToolNames };
    const cwd = opts.cwd ?? process.cwd();

    const session = await AcpAgentSession.start(backend, { cwd, schema, policy, signal: opts.signal });
    try {
      opts.signal?.throwIfAborted();
      await applyModelSelection(session, opts);

      const text = buildPrompt(prompt, opts, Boolean(schema));
      const promptMeta = backend.promptMeta(schema);
      await session.prompt(text, promptMeta);
      opts.signal?.throwIfAborted();

      if (schema) {
        const structuredSession: StructuredSession = {
          prompt: async (repromptText: string) => {
            await session.prompt(repromptText, promptMeta);
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
      session.dispose();
    }
  }
}

/** Factory the mcp-server composition root calls to inject the runner into the engine. */
export function createAcpRunner(): AgentRunner {
  return new AcpAgentRunner();
}

async function applyModelSelection(session: AcpAgentSession, opts: AnyRunOptions): Promise<void> {
  // `model` wins; `tier` is consulted only when `model` is unset (frozen contract).
  const spec = opts.model ?? opts.tier;
  if (!spec) return;
  const { matched, resolved } = await session.selectModel(spec);
  if (matched) opts.onModelResolved?.(resolved ?? spec);
  else opts.onModelFallback?.(spec);
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
