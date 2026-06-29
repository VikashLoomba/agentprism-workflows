# ACP + MCP Dynamic Workflow Orchestrator — Design & API Reference

A working document for a **Pi-independent** rebuild of `pi-dynamic-workflows`. It records
*what* we're building, *which libraries* we use, and *what each library actually supports*
with concrete, package-specific API references (field/method names, file:line, versions) so
the implementation path is unambiguous.

> This is a reference/design doc, not a roadmap. It describes the system and how its pieces fit.

---

## 1. Goal

Rebuild the dynamic-workflow orchestrator so it has **no dependency on Pi**:

- The **`workflow` tool** is exposed by a **stdio MCP server** (instead of a Pi extension's
  `registerTool`). Any MCP-capable host (Claude Code, Zed, etc.) can call it.
- Each **`agent()` call inside a workflow script** is backed by an **ACP agent server**
  (`claude-agent-acp` for Claude, `codex-acp` for Codex) over the **Agent Client Protocol**
  (instead of Pi's in-process `createAgentSession`).

The deterministic orchestration engine (the JS `vm` realm, `parallel`/`pipeline`, the
journal/resume machinery, token budget, git-worktree isolation) is **reused essentially
unchanged** from `pi-dynamic-workflows` — only the *leaf* (how one subagent runs) and the
*shell* (how the tool is exposed) change.

This is built as a **new, standalone codebase** that *lifts* the reused pieces (copy + adapt the
source) rather than modifying the Pi extension; nothing imports Pi at runtime. It is split into
three modules so the agent logic and the engine are each usable on their own, independent of the
MCP server — see §2 for the module layout.

### The core inversion

The orchestrator process plays **two protocol roles at once**:

```
   MCP host (Claude Code / Zed / …)
        │  calls tool "workflow"  (MCP, stdio)
        ▼
┌──────────────────────────────────────────────┐
│  workflow-orchestrator process                │
│   • MCP SERVER  → exposes the `workflow` tool │
│   • ACP CLIENT  → drives agent servers        │
│   • the deterministic engine runs the script  │
└──────────────────────────────────────────────┘
        │  session/new, session/prompt … (ACP, JSON-RPC over stdio)
        ▼
   claude-agent-acp / codex-acp  (one or more long-lived subprocesses)
        │  → real Claude / Codex agents, each in its own session
```

ACP and MCP are sibling JSON-RPC protocols from the same design space (ACP = host↔agent,
MCP = agent↔tools), so this is a clean composition, not a hack.

---

## 2. Codebase & module structure

This is a **new, greenfield codebase** — not a fork, a patch, or a runtime dependency of the Pi
extension. We **lift** the specific pieces of `pi-dynamic-workflows` we need (copy + adapt the
source) and write the rest fresh. Nothing imports Pi at runtime.

The code is split into **three modules** with a one-way dependency direction, so each lower layer
is usable on its own — in particular, the ACP agent logic and the workflow engine are both usable
**with no MCP server at all**.

```
                 ┌────────────────────────────────────────────────┐
                 │  mcp-server   (the shell / one entrypoint)      │
                 │   • the `workflow` TOOL DEFINITION + handler    │
                 │   • stdio MCP transport, progress, resume param │
                 └───────────────┬────────────────┬───────────────┘
                       composes …  │                │
                 ┌───────────────▼───────┐  ┌──────▼────────────────────────┐
                 │  workflow-engine      │  │  acp-agents                   │
                 │   vm runtime,         │  │   ACP client + Claude/Codex   │
                 │   parallel/pipeline,  │  │   backends; structured output,│
                 │   journal, budget,    │  │   model select, permissions,  │
                 │   resume, worktree    │  │   usage, cancel               │
                 └───────────┬───────────┘  └──────────┬────────────────────┘
                             │   meet at the AgentRunner interface (DI)
                             └──────────────┬──────────┘
                                   run(prompt, opts) → result
```

`workflow-engine` and `acp-agents` are **siblings**: neither imports the other. They meet only at
the `AgentRunner` interface (`run(prompt, opts) → result`), injected at composition time. The
engine never names a concrete backend; the agents module never knows it's inside a workflow.

### `acp-agents` — *its own module, independent of the MCP server and the engine*

All the logic for actually using the ACP agents: opening and holding ACP client connections to
`claude-agent-acp` / `codex-acp`, the `ClaudeBackend` / `CodexBackend`, model selection (§5.4),
permission allow/deny (§5.5), usage extraction (§5.6), cancellation (§5.7), and the
structured-output vendor wiring (§6). It exposes one method — `run(prompt, opts): Promise<result>`
— satisfying the `AgentRunner` interface. Depends only on `@agentclientprotocol/sdk`.

Usable standalone, with no workflow and no MCP server:

```ts
import { ClaudeAcpAgent } from "acp-agents";
const agent = new ClaudeAcpAgent({ /* server spawn + auth */ });
const result = await agent.run("Summarize repo X", { schema: MY_SCHEMA, cwd, model: "opus" });
```

### `workflow-engine` — the lifted Pi engine

`runWorkflow` (the `vm` realm + determinism prelude; the
`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` globals), the journal/resume, per-phase
budgets, the limiter, the run manager + persistence, and the worktree helper. It depends on an
**injected `AgentRunner`** — *not* on `acp-agents` — so it runs against a real ACP runner, a mock,
or any other backend (exactly how the Pi tests drive it today via `options.agent`). The seam:
`runWorkflow` accepts `options.agent?: AgentRunner` and only ever calls
`agentRunner.run(prompt, opts)` (today `Pick<WorkflowAgent,"run">`, [`src/workflow.ts:59`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L59), used at
`:283`).

### `mcp-server` — the shell / composition root

Owns the **`workflow` tool definition** (input schema + handler) and the stdio MCP transport;
streams progress via MCP `notifications/progress`; exposes the `resumeFromRunId` param. It wires
an `acp-agents` runner into `workflow-engine` and registers the tool. It is just **one** consumer
— the engine + agents could equally be driven by a CLI, a test harness, or another server, with no
MCP involved.

> Packaging is open: a monorepo with three packages (`acp-agents` independently publishable), or a
> single package with three internal module directories. Either way the dependency direction and
> the `AgentRunner` seam are the contract.

### Lifted from `pi-dynamic-workflows` → `workflow-engine` (copied/adapted, mostly unchanged)

| Concern | Source (`pi-dynamic-workflows`) | Notes |
|---|---|---|
| Script execution | [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) — `runWorkflow`, `vm.createContext`/`vm.Script` (`:835`,`:866`) | Node `vm` realm; globals `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` injected |
| Determinism | [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) `DETERMINISM_PRELUDE` (`:227`), parse blocklist (`:212`,`:890`) | neuters `Date.now`/`Math.random`/`new Date()` for resume reproducibility |
| Fan-out | `parallel` (`:555`, barrier), `pipeline` (`:579`, no barrier), `createLimiter` (`:1013`) | concurrency gate |
| Journal / resume | [`src/run-persistence.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/run-persistence.ts), journal in [`workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) (`hashAgentCall` `:1045`, `firstMiss` longest-unchanged-prefix `:407`) | crash recovery + resume |
| Budget | `budget` object (`:315`), per-phase sub-budgets (`:303`) | soft token gate |
| Worktree isolation | [`src/worktree.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/worktree.ts) — `git worktree add` per agent | engine creates it (deterministic name) and passes `cwd` to `agent.run({cwd})` |
| Model tiering logic | [`src/model-routing.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/model-routing.ts), [`src/model-tier-config.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/model-tier-config.ts) | pure logic; resolution *target* becomes an ACP session config option (§5.4) |
| Schema validate/extract | [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) `resolveStructuredOutput` (`:113`), `extractValidated` (`:47`) | lifted into **`acp-agents`** (not the engine) as the schema guard (§6) |

### Written fresh in the new codebase

| Module | Piece | Replaces (Pi) | New |
|---|---|---|---|
| `acp-agents` | **Leaf** — run one subagent | `WorkflowAgent` in [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) (`createAgentSession`, `ModelRegistry`, `createCodingTools`) | `ACPAgent.run()` — drives `claude-agent-acp` / `codex-acp` over ACP |
| `mcp-server` | **Shell** — expose the tool | [`extensions/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/extensions/workflow.ts) + `createWorkflowTool` `defineTool` + TUI ([`display.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/display.ts), [`task-panel.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/task-panel.ts), [`workflow-ui.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-ui.ts)) | stdio MCP server registering the `workflow` tool; progress via MCP notifications |
| `acp-agents` | **Structured output** | injected `structured_output` tool ([`src/structured-output.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/structured-output.ts)) | native backend schema constraint (§6); the injected tool is no longer the primary path |

---

## 3. Libraries & packages

All versions below were verified locally (cloned + `npm install`) on 2026-06-29.

### Tool exposure (MCP server)

- **`@modelcontextprotocol/sdk`** — official TypeScript MCP SDK. Use its stdio server
  transport to expose the `workflow` tool. (Pulled transitively by claude-agent-sdk as
  `@modelcontextprotocol/sdk@1.29.0`; pin your own direct dependency.)
  Ref: https://github.com/modelcontextprotocol/typescript-sdk · https://modelcontextprotocol.io

### Agent backends (ACP)

- **`@agentclientprotocol/sdk@1.0.0`** — the ACP protocol SDK (JSON-RPC-over-stdio types +
  client/connection helpers). This is what your orchestrator uses to *speak ACP as a client*.
  Ref: https://agentclientprotocol.com · https://github.com/agentclientprotocol

- **`@agentclientprotocol/claude-agent-acp@0.53.0`** — ACP server wrapping Claude.
  Bin: `claude-agent-acp` (`npx @agentclientprotocol/claude-agent-acp`). Author: Zed Industries.
  Wraps **`@anthropic-ai/claude-agent-sdk@0.3.195`**.
  Ref: https://github.com/agentclientprotocol/claude-agent-acp
  > Naming note: the canonical package is **`claude-agent-acp`**, not "claude-acp".

- **`@agentclientprotocol/codex-acp@1.0.2`** — ACP server wrapping OpenAI Codex (TypeScript
  rewrite over the **Codex App Server**). Bin: `codex-acp` (`npx -y @agentclientprotocol/codex-acp`).
  Ref: https://github.com/agentclientprotocol/codex-acp
  > The Rust `zed-industries/codex-acp` is the deprecated predecessor; development moved to the
  > `agentclientprotocol/codex-acp` TypeScript package.

### Engine support (lifted from pi-dynamic-workflows; no Pi runtime needed)

- **`acorn`** — parse the workflow script + extract/validate the `meta` literal.
- **`node:vm`**, **`node:crypto`** — script realm + journal hashing.
- A JSON-Schema lib (**`typebox`** today, or **`zod`** — note `claude-agent-acp` itself uses
  `zod ^3.25 || ^4`) for the `agent({schema})` contract and client-side validation.
- **`git`** — worktree isolation (`git worktree add/remove`).

---

## 4. The MCP side — exposing the `workflow` tool

The `workflow` tool keeps essentially the same input contract as today
([`src/workflow-tool.ts:61`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-tool.ts#L61)), exposed via the MCP server instead of `defineTool`:

- `script` (**required** string) — raw JS; must start with
  `export const meta = { name, description, phases? }` and call `agent()` at least once.
- `args` (optional) — exposed to the script as global `args`.
- `maxAgents` (optional, default 1000), `concurrency` (optional, clamped to 16),
  `agentRetries` (optional, ≤3), `agentTimeoutMs` (optional, default none),
  `tokenBudget` (optional, default none).

**One semantic changes vs. Pi.** MCP tool calls are request/response within the caller's turn;
there is no "return immediately, deliver the result into a *later* turn" mechanism (that was a
Pi-extension affordance, `installResultDelivery`). So the MCP `workflow` tool runs
**synchronously**: execute to completion, stream progress via MCP **`notifications/progress`**,
return the final result. This is exactly the existing `background:false` / `runSync` path
([`src/workflow-tool.ts:223`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-tool.ts#L223)) — make it the default and drop `startInBackground`.

Resume is **not lost**, it becomes **explicit**: expose a `resumeFromRunId` tool parameter; the
host calls `workflow` again to continue from the persisted journal (the engine already supports
this via `resumeJournal` in `runWorkflow`).

Human-in-the-loop: `checkpoint()` relied on Pi's `ui.confirm`. Over MCP it falls back to the
headless default (already handled at [`src/workflow.ts:819`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L819)), unless the MCP client supports
**elicitation**, which you can wire `checkpoint()` to.

---

## 5. The ACP side — driving agent servers

ACP is **JSON-RPC 2.0 over stdio**, newline-delimited (messages MUST NOT contain embedded
newlines; stdout = protocol, stderr = free for logs). Protocol version is `1`.
Spec: https://agentclientprotocol.com/protocol/v1/transports

### 5.1 Lifecycle / a single turn

```
initialize                         → capability handshake (protocolVersion, clientCapabilities, authMethods)
session/new   { cwd, mcpServers }  → returns sessionId (+ configOptions)
session/prompt { sessionId, prompt }  (request)
  ↳ session/update  notifications  → agent_message_chunk, tool_call, tool_call_update,
                                      plan, usage_update, …  (streaming, agent→client)
session/prompt response            → { stopReason, usage? }
session/cancel { sessionId }       (notification, client→agent)
```

- **Stop reasons** (on the `session/prompt` result): `end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`.
  Ref: https://agentclientprotocol.com/protocol/v1/prompt-turn

### 5.2 Sessions & concurrency — supported

A single agent-server **process hosts many concurrent sessions** (each keyed by `sessionId`).
Both servers implement a real `sessionId → session` map:

- `claude-agent-acp`: `sessions` map; prompts on **different** sessions run concurrently;
  prompts **within** one session are queued (`promptQueueing`). (`src/acp-agent.ts`)
- `codex-acp`: `private readonly sessions: Map<string, SessionState>` with per-session prompt
  state + generation fencing. (`src/CodexAcpServer.ts`)

**Efficient fan-out:** run one (or a few) long-lived server processes and open **N sessions**;
the engine's `createLimiter` caps real concurrency. You're bound by API rate limits and
per-session memory, not by the protocol.
Ref: https://agentclientprotocol.com/protocol/v1/session-setup

### 5.3 Working directory / worktree isolation — supported, clean

`cwd` is a **required, per-session, absolute** field on `session/new` (independent per session
in one process); optional `additionalDirectories` expands the root set. So worktree isolation
maps directly: `createWorktree()` → `session/new({ cwd: worktree.cwd })`. Both servers store
`cwd` per session.
Ref: https://agentclientprotocol.com/protocol/v1/session-setup#working-directory

### 5.4 Model selection — supported, via Session Config Options (not `session/new`, not `initialize`)

The client picks the model **per session** (switchable per turn) from the catalog the agent
advertises:

- Mechanism: agent returns `configOptions` (in the `session/new` result, updatable later)
  including `{ id:"model", category:"model", type:"select", currentValue, options[] }`;
  client switches with **`session/set_config_option`** `{ configId:"model", value }`.
  Categories also include `model_config` (context/speed/quality) and `thought_level`.
  Refs: https://agentclientprotocol.com/protocol/v1/session-config-options ·
  https://agentclientprotocol.com/rfds/model-config-category
- `claude-agent-acp`: `model` option → `query.setModel(...)`; accepts aliases (`opus`/`sonnet`);
  initial precedence `ANTHROPIC_MODEL` env → `settings.model` → SDK default; per-call override
  `_meta.claudeCode.options.model`.
- `codex-acp`: model encoded as `"model[effort]"` (e.g. `gpt-5.2[high]`) + separate
  `reasoning_effort` select; switch via `session/setConfigOption`.

> The **catalog** belongs to the server (Claude models on `claude-agent-acp`, Codex models on
> `codex-acp`), so cross-**provider** routing = choosing which server; within a provider,
> per-call tiering works. This is what the engine's `tier: small/medium/big` maps onto.

### 5.5 Permissions → tool allow/deny — supported

The agent requests approval per gated tool call via **`session/request_permission`**
(agent→client), with options whose `kind ∈ {allow_once, allow_always, reject_once,
reject_always}`. The spec explicitly allows clients to **auto-respond**, so an allow/deny-list
is implemented by deciding at that boundary (by tool name / command / kind) without user
interaction. Both servers also expose coarse permission modes (`acceptEdits`, `plan`, `dontAsk`,
`bypassPermissions`/`agent-full-access`, …).
Ref: https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission

### 5.6 Usage / token accounting — supported

- **`usage_update`** `session/update` notification: `used` + `size` (token counts), optional
  `cost { amount, currency }`.
- Per-turn `usage` object on the `session/prompt` response (still a **Draft RFD**, but both
  servers already emit it).
- `claude-agent-acp` reports **tokens + dollar cost** (`cost = total_cost_usd`, USD); response
  `usage { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens }`.
- `codex-acp` reports **tokens/quota only** (no dollar cost).

This maps onto the engine's `onUsage` / token accounting; no need for the chars/4 estimator
fallback in the normal case.
Refs: https://agentclientprotocol.com/protocol/v1/prompt-turn · https://agentclientprotocol.com/rfds/session-usage

### 5.7 Cancellation — supported

`session/cancel { sessionId }` is a fire-and-forget notification; the agent aborts model+tool
work and then resolves the original `session/prompt` with `stopReason: "cancelled"`. A
`session/close` (when advertised) also frees the session. Maps onto the engine's
`AbortController`/`signal`.
Ref: https://agentclientprotocol.com/protocol/v1/cancellation

### 5.8 Giving agents extra tools — `mcpServers` on `session/new`

The client passes MCP server configs (stdio mandatory; http/sse optional per capability) in
`session/new`; the agent connects to them. This is the **only** client-side tool-injection path
in ACP (the client does not hand the agent a tool object directly).
- `claude-agent-acp`: ACP `mcpServers` → SDK `McpServerConfig`, merged with user options
  (`src/acp-agent.ts:3127-3149`, `:3242`).
- `codex-acp`: supports stdio + http (rejects `acp`/`sse`).
Ref: https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers

---

## 6. Structured output (the crux)

**Both backends natively constrain a result to a JSON Schema.** What differs is *scope* and the
*vendor channel* used to reach it. ACP **core** models none of it — only an open `_meta`
extension point — so each backend tunnels its native support through a vendor-specific path.

### 6.1 ACP core (`@agentclientprotocol/sdk@1.0.0`) — no native structured output

Verified by exhaustive grep (zero matches for `outputSchema|structuredContent|json_schema|…`).

```ts
// dist/schema/types.gen.d.ts:5017
export type PromptRequest = {
  sessionId: SessionId;
  prompt: Array<ContentBlock>;
  _meta?: { [key: string]: unknown } | null;   // the ONLY extension point
};
// :2943  PromptResponse = { stopReason, usage?, _meta }   — no result payload
// :213   ToolCallContent = Content | Diff | Terminal      — no structuredContent
```

### 6.2 Claude — `@agentclientprotocol/claude-agent-acp@0.53.0` → `@anthropic-ai/claude-agent-sdk@0.3.195`

**Supported, session-scoped, via the `_meta.claudeCode` vendor extension.**

**(a) Set the schema — IN.** The SDK's `Options.outputFormat` is the native lever:

```ts
// claude-agent-sdk  sdk.d.ts:1651
/** Output format configuration for structured responses.
 *  When specified, the agent will return structured data matching the schema. */
outputFormat?: OutputFormat;
// :1981  OutputFormat = JsonSchemaOutputFormat
// :870   JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }
// :1983  OutputFormatType = 'json_schema'
```

The adapter **spreads the client-supplied options straight into the SDK query**, so a client
sets it via `_meta.claudeCode.options.outputFormat` at `session/new`:

```ts
// claude-agent-acp  src/acp-agent.ts:3180
const userProvidedOptions = sessionMeta?.claudeCode?.options;   // = params._meta.claudeCode.options
// :3216
const options: Options = {
  systemPrompt,
  settingSources: ["user", "project", "local"],
  ...(thinking !== undefined && { thinking }),
  ...userProvidedOptions,   // ← :3220  carries outputFormat straight into the SDK query
  // ACP-managed overrides AFTER the spread (cwd, mcpServers, permissionMode, tools,
  // canUseTool, hooks, env, …) do NOT touch outputFormat
};
```

Client `session/new` payload:

```jsonc
{
  "cwd": "/abs/path/to/worktree",
  "_meta": {
    "claudeCode": {
      "options": {
        "outputFormat": { "type": "json_schema", "schema": { /* your JSON Schema */ } }
      },
      "emitRawSDKMessages": true          // required to READ the result (see (c))
    }
  }
}
```

**(b) Constraint + retry — built in.** The SDK validates the final message against the schema
and retries; on exhaustion it ends with a terminal subtype:

```ts
// claude-agent-sdk  sdk.d.ts:3943  (SDKResultError.subtype)
'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
```

The adapter already handles that subtype (`src/acp-agent.ts:1763`, mapped to an internal
error / `max_turn_requests` stop reason).

**(c) Read the result — OUT (the one rough edge).** The parsed object lands in:

```ts
// claude-agent-sdk  sdk.d.ts:3983  (SDKResultSuccess)
structured_output?: unknown;
```

…but ACP `PromptResponse` only carries `{ stopReason, usage }`, and the adapter does **not** give
`structured_output` a first-class ACP field. You read it by opting into raw SDK messages:

```ts
// claude-agent-acp  src/acp-agent.ts:357 (flag), :3488 (wired), :1337 (forwarded)
if (session.emitRawSDKMessages && shouldEmitRawMessage(session.emitRawSDKMessages, message)) {
  await this.client.extNotification("_claude/sdkMessage", {
    sessionId: params.sessionId,
    message: message as Record<string, unknown>,
  });
}
```

So: set `_meta.claudeCode.emitRawSDKMessages = true`, then read `structured_output` off the
`_claude/sdkMessage` notification carrying the `type:"result", subtype:"success"` message.

**Scope:** **session-scoped** — `outputFormat` is read at `session/new`; `prompt()`
(`src/acp-agent.ts:1034`) reads no per-turn schema. With the engine's one-session-per-`agent()`
model this is a non-issue (one schema per agent call = one session).

### 6.3 Codex — `@agentclientprotocol/codex-acp` (Codex App Server)

**Supported two ways, and the turn-level path is cleaner (per-turn, at the params level).**

**(a) Turn-level — constrain the final assistant message:**

```ts
// codex-acp  src/app-server/v2/TurnStartParams.ts:43-46
/** Optional JSON Schema used to constrain the final assistant message for this turn. */
outputSchema?: JsonValue | null;
// src/app-server/SendUserTurnParams.ts:13-16  (v1) — same semantics: outputSchema: JsonValue | null
```

**(b) Tool-level — tool defs declare an output schema; results carry structured data:**

```ts
// src/app-server/Tool.ts:9            outputSchema?: JsonValue   (on the tool definition)
// src/app-server/ToolOutputSchema.ts:6-10   { properties?, required?: string[], type: string }
// src/app-server/CallToolResult.ts:9          structuredContent?: JsonValue
// src/app-server/v2/McpToolCallResult.ts:6    structuredContent: JsonValue | null
// src/app-server/v2/McpServerToolCallResponse.ts:6  structuredContent?: JsonValue
```

### 6.4 Why tool-level structured output is the wrong lever for a *client*

For both backends, a tool's `structuredContent` flows back to **the model**, not to your
orchestrator. The SDK's in-process `tool()` helper exposes **no `outputSchema`**
(`claude-agent-sdk sdk.d.ts:6506`, `:3683`). The only client-capturable tool signal is the
tool's **inputSchema** (the *args* the model passes when it calls a client-hosted tool). So
schema-conformance for a subagent **result** should use the turn/session output format, not a
tool.

### 6.5 What this means for us

- **Drop the injected `structured_output` tool as the primary path.** The backend constrains
  natively (stronger than hoping the model calls a tool).
- **Keep `resolveStructuredOutput`'s validate-then-re-prompt ([`src/agent.ts:113`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts#L113)) as a guard**,
  because `structured_output` is typed `unknown` and the constraint can still fail
  (`error_max_structured_output_retries`). Ladder: native constraint → client-side validate →
  re-prompt on failure.
- **Abstract behind a per-backend adapter** — the two paths genuinely differ (Claude:
  session-scoped vendor `_meta.claudeCode` + `emitRawSDKMessages`; Codex: per-turn
  `outputSchema` at the params level). Same `run(prompt, { schema })` interface above them.

---

## 7. The leaf interface: `ACPAgent.run(prompt, opts)`

This lives in the **`acp-agents`** module (§2) and is usable on its own — no `workflow-engine`,
no `mcp-server`. It implements the `AgentRunner` seam the engine injects against (today
`Pick<WorkflowAgent, "run">`, [`src/workflow.ts:59`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L59)). One method, two backend strategies behind it:

```
run(prompt, { schema?, model?, tier?, cwd?, signal?, toolNames?, … }) →
  1. pick backend (Claude vs Codex) by agentType/model
  2. session/new({ cwd: worktree?.cwd })           // §5.3 worktree isolation
  3. select model via session config option         // §5.4
  4. apply schema:
       Claude → already set in session/new _meta.claudeCode.options.outputFormat (+ emitRawSDKMessages)
       Codex  → outputSchema on the turn params
  5. session/prompt(prompt); drain session/update:
       • agent_message_chunk → assistant text
       • tool_call / request_permission → enforce allow/deny (§5.5)
       • usage_update → token accounting (§5.6)
  6. on stopReason:
       schema set → extract structured result
                     (Claude: structured_output off _claude/sdkMessage; Codex: structuredContent/result),
                     then VALIDATE; re-prompt on failure (guard)
       no schema   → final assistant text (empty ⇒ recoverable retry)
  7. signal.aborted → session/cancel (§5.7)
```

Everything above this method — `parallel`/`pipeline`, the journal, budget, phases, resume — is
the unchanged engine.

---

## 8. Caveats / version pins / things to design around

- **Version-specific (Claude):** the structured-output path is verified for
  `claude-agent-acp@0.53.0` / `@anthropic-ai/claude-agent-sdk@0.3.195`. The `_meta.claudeCode`
  channel and `emitRawSDKMessages` are vendor extensions, not standard ACP — pin versions and
  isolate behind the backend adapter.
- **`emitRawSDKMessages` is mandatory** to read `structured_output` on the Claude path; filter
  the raw stream to just the `type:"result"` message.
- **Schema scope (Claude) is per-session** → spin up a fresh ACP session per `agent()` call (or
  per distinct schema). The engine already does one session per call.
- **MCP turn semantics:** no "deliver result into a later turn" — run the `workflow` tool
  synchronously with progress notifications; expose `resumeFromRunId` for continuation.
- **Cross-provider routing = choose the server.** Per-call model tiering works *within* a
  provider via config options; switching providers means routing to a different ACP server.
- **Concurrency** is bound by provider API rate limits + per-session memory, not the protocol;
  intra-session prompts serialize.
- **Per-turn token-usage breakdown** on `PromptResponse` is still a Draft ACP RFD (servers emit
  it ahead of stabilization). `codex-acp` reports tokens/quota but **no dollar cost**.
- **`codex-acp` config options** were temporarily disabled for one client build (JetBrains
  2026.1) — verify config-option availability against the host you target.

---

## 9. References

**Packages (verified versions, 2026-06-29):**
- `@modelcontextprotocol/sdk` (stdio MCP server) — https://github.com/modelcontextprotocol/typescript-sdk
- `@agentclientprotocol/sdk@1.0.0` — https://github.com/agentclientprotocol
- `@agentclientprotocol/claude-agent-acp@0.53.0` (wraps `@anthropic-ai/claude-agent-sdk@0.3.195`) — https://github.com/agentclientprotocol/claude-agent-acp
- `@agentclientprotocol/codex-acp@1.0.2` — https://github.com/agentclientprotocol/codex-acp

**ACP spec:**
- Overview / transports — https://agentclientprotocol.com/protocol/v1/transports
- Initialization — https://agentclientprotocol.com/protocol/v1/initialization
- Session setup (cwd, mcpServers) — https://agentclientprotocol.com/protocol/v1/session-setup
- Prompt turn / stop reasons / usage — https://agentclientprotocol.com/protocol/v1/prompt-turn
- Tool calls / permissions — https://agentclientprotocol.com/protocol/v1/tool-calls
- Session config options (model) — https://agentclientprotocol.com/protocol/v1/session-config-options
- Cancellation — https://agentclientprotocol.com/protocol/v1/cancellation
- Extensibility (`_meta`, `_`-methods) — https://agentclientprotocol.com/protocol/v1/extensibility

**Reused engine (lifted from [`pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows)):**
- [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) — engine, vm, determinism, journal, `agent`/`parallel`/`pipeline`, budget
- [`src/workflow-manager.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-manager.ts) — run lifecycle, persistence, resume
- [`src/run-persistence.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/run-persistence.ts) — disk journal + leases
- [`src/worktree.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/worktree.ts) — git-worktree isolation
- [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) — the leaf being replaced; `resolveStructuredOutput`/`extractValidated` reused as the schema guard
