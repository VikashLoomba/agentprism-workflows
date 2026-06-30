# @automatalabs/acp-agents

Low-level building block: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client plus Claude and Codex backends that implement the `AgentRunner` seam from `@automatalabs/shared-types`. It spawns `claude-agent-acp` / `codex-acp` as child processes, drives one subagent turn to completion over ACP, and returns structured output or text.

This is the layer `@automatalabs/workflows` and `@automatalabs/mcp-server` are built on.

## Most users want `@automatalabs/workflows`

If you are orchestrating a workflow, use [`@automatalabs/workflows`](../workflows) instead — it re-exports `createAcpRunner` and wires it into the engine for you. Reach for this package directly only when you want to drive a **single** Claude/Codex agent over ACP yourself.

```bash
npm install @automatalabs/acp-agents
```

## Standalone use: drive one agent

`createAcpRunner().run(prompt, options)` runs a single agent to completion. Pass a [typebox](https://github.com/sinclairzx81/typebox) `schema` to get a validated object back (typed as `Static<typeof schema>`); omit it to get the final assistant text as a `string`. The backend (Claude vs Codex) is selected from `model` / `tier`. Call `dispose()` when you're done to tear down the pooled child processes.

```ts
import { createAcpRunner } from "@automatalabs/acp-agents";
import { Type } from "typebox";

const runner = createAcpRunner();

try {
  // Structured output: result is typed and validated against the schema.
  const review = await runner.run("Review the diff and summarize risk.", {
    schema: Type.Object({
      risk: Type.Union([Type.Literal("low"), Type.Literal("high")]),
      summary: Type.String(),
    }),
    model: "anthropic/claude-sonnet-4", // routes to the Claude backend
    cwd: "/abs/path/to/worktree",       // ACP session/new { cwd } — absolute
  });
  console.log(review.risk, review.summary);

  // No schema: result is the final assistant text.
  const text = await runner.run("Explain this repo in one paragraph.", {
    model: "openai/gpt-5", // routes to the Codex backend
    cwd: "/abs/path/to/worktree",
  });
  console.log(text);
} finally {
  await runner.dispose();
}
```

`run()` accepts the full `RunOptions` seam: `schema`, `model`, `tier`, `cwd`, `instructions`, `label`, `signal` (cancellation), `toolNames` / `disallowedToolNames`, `mcpServers`, `onUsage`, `onModelResolved`, `onModelFallback`, and `onHistory`. See `@automatalabs/shared-types` for the field-by-field contract.

## Key exports

From [`src/index.ts`](./src/index.ts):

- **`createAcpRunner(options?)`** — factory returning an `AcpAgentRunner` (this is what `@automatalabs/workflows` injects into the engine).
- **`AcpAgentRunner`** — the `AgentRunner` implementation; `run(prompt, options)` and `dispose()`.
- **`selectBackend({ model, tier })`** — the cross-provider routing rule: which backend a spec maps to.
- **`ClaudeBackend` / `CodexBackend`** — the two backend strategies (spawn config + per-backend schema wiring).
- **`toJsonSchema(schema)` / `toStrictJsonSchema(schema)`** — turn a typebox schema into the on-the-wire shapes: a plain JSON Schema for Claude `outputFormat`, and an OpenAI-strict-normalized schema for Codex `outputSchema`.

Also exported: `AcpAgentPool` / `resolvePoolSize`, `PooledConnection` / `SessionHandle`, `decidePermission`, `UsageAccumulator`, `resolveStructuredOutput` / `extractValidated` / `findJsonBlock` / `validateValue`, and `errorText` / `mapThrownError`, plus their associated types.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | Backend when `model`/`tier` don't pick one (`codex` selects Codex; anything else is Claude). |
| `AGENTPRISM_ACP_POOL_SIZE` | Long-lived processes to keep per backend (default `1`). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `AGENTPRISM_CLAUDE_ACP_ARGS` | Override the command (and args) used to spawn the Claude ACP server. |
| `AGENTPRISM_CODEX_ACP_CMD` / `AGENTPRISM_CODEX_ACP_ARGS` | Override the command (and args) used to spawn the Codex ACP server. |
| `AGENTPRISM_CODEX_ACP_BIN` | Override only the resolved Codex ACP bin path (keeps the default node launcher). |

## License

Apache-2.0
