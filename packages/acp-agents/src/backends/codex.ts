// CodexBackend — drives the installed npm dep @automatalabs/codex-acp, a published fork of
// @agentclientprotocol/codex-acp that bakes in the outputSchema patch. The patch forwards
// request._meta["agentprism/outputSchema"] into the Codex App Server's turn/start.outputSchema,
// which the shipped @openai/codex binary honors end-to-end as an OpenAI Responses-API STRICT
// constraint on the final assistant message. So the schema rides per-PROMPT `_meta` (not
// session/new), normalized to OpenAI strict rules first. Output needs no special channel: the
// constrained final message flows back over the normal agent-message stream, so the backend
// reads the final text and JSON.parses it.
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import type { Backend, SpawnConfig, StructuredSource } from "../backend.js";
import { splitArgs } from "../backend.js";
import { toStrictJsonSchema } from "../schema-strict.js";
import { findJsonBlock } from "../structured-output.js";

const require = createRequire(import.meta.url);

export class CodexBackend implements Backend {
  readonly id = "codex" as const;

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_CODEX_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_CODEX_ACP_ARGS), env };
    }
    // Run the installed codex-acp under the current node. AGENTPRISM_CODEX_ACP_BIN overrides the
    // resolved path; otherwise resolve the package's main (dist/index.js) from node_modules so it
    // ships on a clean `git clone && pnpm install` (the @automatalabs/codex-acp fork already bakes
    // in the outputSchema patch). Works from both src/ and the compiled dist/.
    const bin =
      env.AGENTPRISM_CODEX_ACP_BIN ?? require.resolve("@automatalabs/codex-acp");
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
