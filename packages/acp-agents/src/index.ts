// @automatalabs/acp-agents — implements the AgentRunner seam from @automatalabs/shared-types over
// the Agent Client Protocol. It spawns claude-agent-acp / the installed npm dep codex-acp
// (patched via pnpm patchedDependencies) as child processes and drives one subagent run to
// completion. It NEVER imports
// @automatalabs/workflow-engine; the two siblings meet ONLY at AgentRunner, injected by
// mcp-server (the composition root) via createAcpRunner().
export { AcpAgentRunner, createAcpRunner, selectBackend } from "./runner.js";

export { PooledConnection, SessionHandle } from "./acp-client.js";
export type { AcpSessionOptions, PooledConnectionDeps } from "./acp-client.js";
export { AcpAgentPool, resolvePoolSize } from "./pool.js";
export type { AcpPoolOptions } from "./pool.js";

export type { Backend, BackendId, SpawnConfig, StructuredSource } from "./backend.js";
export { ClaudeBackend } from "./backends/claude.js";
export { CodexBackend } from "./backends/codex.js";

export { decidePermission } from "./permissions.js";
export type { ToolPolicy } from "./permissions.js";

export { UsageAccumulator } from "./usage.js";

export { toJsonSchema, toStrictJsonSchema } from "./schema-strict.js";

export {
  extractValidated,
  findJsonBlock,
  resolveStructuredOutput,
  validateValue,
} from "./structured-output.js";
export type { ResolveOptions, StructuredSession } from "./structured-output.js";

export { errorText, mapThrownError } from "./errors-map.js";
