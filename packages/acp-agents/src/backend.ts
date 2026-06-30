// The internal Backend strategy (NOT part of @automatalabs/shared-types). One AcpAgentSession
// transport drives either backend; the Backend supplies the three things that genuinely
// differ between Claude and Codex:
//   1. how to spawn the ACP server subprocess,
//   2. the vendor `_meta` that carries the schema IN (Claude: session/new
//      _meta.claudeCode.options.outputFormat + emitRawSDKMessages; Codex: per-turn
//      _meta["agentprism/outputSchema"], strict-normalized),
//   3. how to read the native structured result OUT (Claude: structured_output off the raw
//      _claude/sdkMessage; Codex: JSON.parse the final assistant message off the stream).
import type { TSchema } from "typebox";

export type BackendId = "claude" | "codex";

export interface SpawnConfig {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The slice of an active session a Backend reads to extract the native structured result. */
export interface StructuredSource {
  /** The latest turn's accumulated assistant text. */
  currentTurnText(): string;
  /** Claude only: `structured_output` from the latest `type:"result", subtype:"success"` raw message. */
  rawStructuredOutput(): unknown;
}

export interface Backend {
  readonly id: BackendId;
  /** How to launch this backend's ACP server over stdio. */
  spawnConfig(): SpawnConfig;
  /** `_meta` for session/new (undefined when this backend carries the schema elsewhere). */
  sessionMeta(schema: TSchema | undefined): Record<string, unknown> | undefined;
  /** `_meta` for session/prompt (undefined when this backend carries the schema at session/new). */
  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined;
  /** Read this backend's native structured result for the latest turn (unvalidated), or undefined. */
  nativeStructured(source: StructuredSource): unknown;
}

/** Split a whitespace-separated env override (e.g. AGENTPRISM_CLAUDE_ACP_ARGS) into argv. */
export function splitArgs(value: string | undefined): string[] {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}
