// CodexBackend — drives the VENDORED + PATCHED codex-acp (packages/acp-agents/vendor/codex-acp).
// The ~1-line patch in vendor/codex-acp/src/CodexAcpClient.ts forwards
// request._meta["agentprism/outputSchema"] into the Codex App Server's turn/start.outputSchema,
// which the shipped @openai/codex binary honors end-to-end as an OpenAI Responses-API STRICT
// constraint on the final assistant message. So the schema rides per-PROMPT `_meta` (not
// session/new), normalized to OpenAI strict rules first. Output needs no special channel: the
// constrained final message flows back over the normal agent-message stream, so the backend
// reads the final text and JSON.parses it.
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { META_KEYS } from "@agentprism/shared-types";
import type { Backend, SpawnConfig, StructuredSource } from "../backend.js";
import { splitArgs } from "../backend.js";
import { toStrictJsonSchema } from "../schema-strict.js";
import { findJsonBlock } from "../structured-output.js";

export class CodexBackend implements Backend {
  readonly id = "codex" as const;

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_CODEX_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_CODEX_ACP_ARGS), env };
    }
    // The vendored, patched codex-acp is built (esbuild) to vendor/codex-acp/dist/index.js.
    // AGENTPRISM_CODEX_ACP_BIN overrides the resolved path; otherwise resolve it relative to
    // this module (works from both src/ and the compiled dist/, each two levels under the
    // package root).
    const bin =
      env.AGENTPRISM_CODEX_ACP_BIN ??
      fileURLToPath(new URL("../../vendor/codex-acp/dist/index.js", import.meta.url));
    return { command: process.execPath, args: [bin], env };
  }

  sessionMeta(): Record<string, unknown> | undefined {
    // Codex carries the schema on the turn, not session/new.
    return undefined;
  }

  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined {
    if (!schema) return undefined;
    return { [META_KEYS.outputSchema]: toStrictJsonSchema(schema) };
  }

  nativeStructured(source: StructuredSource): unknown {
    const text = source.currentTurnText().trim();
    if (!text) return undefined;
    // The constrained final message is pure JSON; parse it directly, then fall back to a
    // balanced-block extraction if the turn also emitted leading prose.
    try {
      return JSON.parse(text);
    } catch {
      // fall through to block extraction
    }
    const block = findJsonBlock(text);
    if (block !== undefined) {
      try {
        return JSON.parse(block);
      } catch {
        // give up; the runner's ladder will re-prompt / extract.
      }
    }
    return undefined;
  }
}
